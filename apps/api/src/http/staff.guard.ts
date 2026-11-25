// SPDX-License-Identifier: AGPL-3.0-only
import { type ApiScope, ROLE_IDS, twoFactorRoles } from '@attendra/core';
import { type ApiCaller, authenticateApiKey, type Database, holdsRole, passwordState, type StaffRole, staffRole, withClinic } from '@attendra/db';
import {
  type CanActivate, createParamDecorator, type ExecutionContext, ForbiddenException, Inject, Injectable,
  NotFoundException, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type Permission } from '../access';
import type { Auth } from '../auth';
import { sql } from 'drizzle-orm';
import { API_OPTIONS, type ApiOptions, AUTH, CLOCK, DB } from './tokens';

export interface Staff {
  userId: string;
  name: string;
  email: string;
  twoFactorEnabled: boolean;
  /** A temporary password is still in use: nothing but "who am I" until it is changed. */
  mustChangePassword: boolean;
  /** When this session ends unless it is used again (ISO): 12 hours after its last renewal. */
  sessionExpiresAt: string;
  /** Set on clinic routes, after the membership check. */
  clinicId?: string;
  role?: StaffRole;
}

type StaffRequest = FastifyRequest & { staff?: Staff; apiKey?: ApiCaller };
/** The clinic's API key that made this request, on a route that takes one (KeyScope); undefined on a session's request. */
export const apiKeyOf = (req: FastifyRequest) => (req as StaffRequest).apiKey;

/**
 * Whether this person must have two-step sign-in on (ATTENDRA_TWO_FACTOR): everyone, nobody, or
 * whoever is an owner or practice manager at any of their locations. A promotion counts from the
 * next request, so a new practice manager is sent to set it up before managing anything.
 */
export async function twoFactorNeeded(db: Database, options: Pick<ApiOptions, 'demoMode' | 'twoFactor'>, userId: string): Promise<boolean> {
  if (options.demoMode) return false;
  const roles = twoFactorRoles(options.twoFactor);
  if (roles.length === ROLE_IDS.length) return true;
  return holdsRole(db, userId, roles);
}

const PERMISSION = 'attendra:permission';
const BEFORE_TWO_FACTOR = 'attendra:before-two-factor';
const PUBLIC = 'attendra:public';

/** The permission a clinic route needs. The route must have a :clinicId parameter. */
export const Requires = (permission: Permission) => SetMetadata(PERMISSION, permission);
/** For the few routes a signed-in person needs before their account is ready: before changing a temporary password, and before enrolling in two-factor (who am I?). */
export const BeforeTwoFactor = () => SetMetadata(BEFORE_TWO_FACTOR, true);
/** No session needed. Only the health check and the build's version, which carry no data. */
export const Public = () => SetMetadata(PUBLIC, true);
const KEY_SCOPE = 'attendra:key-scope';
/**
 * A clinic's API key with this scope may read the route instead of a session (the QA export: foundation A). Only a GET,
 * only its own clinic, only while the key is live. Every other route refuses a key: it takes a dashboard session.
 */
export const KeyScope = (scope: ApiScope) => SetMetadata(KEY_SCOPE, scope);
/** A clinic API key in an Authorization header ("Bearer atk_..."), or null. */
const bearerKey = (h: unknown) => (typeof h === 'string' && /^Bearer atk_/.test(h) ? h.slice(7).trim() : null);

export const CurrentStaff = createParamDecorator((_: unknown, ctx: ExecutionContext): Staff => {
  const staff = ctx.switchToHttp().getRequest<StaffRequest>().staff;
  if (!staff) throw new UnauthorizedException();
  return staff;
});

export function toHeaders(raw: FastifyRequest['headers']): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    for (const value of Array.isArray(v) ? v : [v]) headers.append(k, String(value));
  }
  return headers;
}

/**
 * Every /api/v1 request passes here. In order: a write must come from the dashboard's
 * own origin (the session cookie alone is not enough), the session must be valid,
 * a temporary password must have been changed, two-factor must be on, and on clinic routes the person must be a member of the
 * clinic's organization with a role that has the route's permission. A clinic
 * someone does not belong to answers 404, not 403, so ids cannot be probed.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Database,
    @Inject(API_OPTIONS) private readonly options: ApiOptions,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<StaffRequest>();
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T | undefined>(key, [ctx.getHandler(), ctx.getClass()]);
    if (meta<boolean>(PUBLIC)) return true;
    const key = bearerKey(req.headers.authorization);
    if (key !== null) return this.keyRequest(req, key, meta<ApiScope>(KEY_SCOPE));
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== new URL(this.options.publicUrl).origin) {
      throw new ForbiddenException({ error: 'cross_origin_write' });
    }

    // a session used more than an hour after its last renewal is renewed here: its new cookie
    // (12 hours from now) goes back with this answer, or the browser would drop it at the old end
    const { headers: renewed, response: session } = await this.auth.api.getSession({ headers: toHeaders(req.headers), returnHeaders: true });
    if (!session) throw new UnauthorizedException({ error: 'signed_out' });
    const cookies = renewed.getSetCookie();
    if (cookies.length) ctx.switchToHttp().getResponse<FastifyReply>().header('set-cookie', cookies);
    const user = session.user as typeof session.user & { twoFactorEnabled?: boolean | null };
    const password = await passwordState(this.db, { userId: user.id });
    req.staff = {
      userId: user.id, name: user.name, email: user.email, twoFactorEnabled: !!user.twoFactorEnabled, mustChangePassword: !!password?.mustChange,
      sessionExpiresAt: new Date(session.session.expiresAt).toISOString(),
    };

    const beforeTwoFactor = meta<boolean>(BEFORE_TWO_FACTOR);
    // demo mode or not: the person who typed a temporary password must not be able to act as its owner
    if (!beforeTwoFactor && req.staff.mustChangePassword) throw new ForbiddenException({ error: 'password_change_required' });
    if (!beforeTwoFactor && !req.staff.twoFactorEnabled && await twoFactorNeeded(this.db, this.options, user.id)) {
      throw new ForbiddenException({ error: 'two_factor_required' });
    }

    const permission = meta<Permission>(PERMISSION);
    const clinicId = (req.params as { clinicId?: string }).clinicId;
    // fail closed: a clinic route that forgot @Requires is a bug, not an open door
    if (clinicId && !permission) throw new Error(`clinic route ${req.routeOptions.url} has no @Requires`);
    if (!permission) return true;
    if (!clinicId) throw new Error(`route ${req.routeOptions.url} declares ${permission} but has no :clinicId`);
    const role = await staffRole(this.db, user.id, clinicId);
    if (!role) throw new NotFoundException({ error: 'not_found' });
    if (!can(role, permission)) throw new ForbiddenException({ error: 'forbidden', message: `a ${role} cannot ${permission}` });
    req.staff.clinicId = clinicId;
    req.staff.role = role;
    return true;
  }

  /**
   * A request with an API key: only on a route that takes one, to read, for the key's own clinic (another clinic's id
   * answers 404, like a clinic someone does not belong to), with the route's scope. A live key without the scope is
   * refused with 403 and the refusal audited under the key.
   */
  private async keyRequest(req: StaffRequest, key: string, scope: ApiScope | undefined): Promise<boolean> {
    if (!scope) throw new UnauthorizedException({ error: 'api_key_not_accepted', message: 'This route takes a dashboard session, not an API key.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new ForbiddenException({ error: 'read_only', message: 'An API key only reads here.' });
    const caller = await authenticateApiKey(this.db, key, this.now());
    if (!caller) throw new UnauthorizedException({ error: 'invalid_key', message: 'The key is unknown, revoked or expired.' });
    const clinicId = (req.params as { clinicId?: string }).clinicId;
    if (!clinicId || clinicId !== caller.clinicId) throw new NotFoundException({ error: 'not_found' });
    if (!caller.scopes.includes(scope)) {
      await withClinic(this.db, caller.clinicId, (tx) => tx.execute(sql`insert into audit_logs (clinic_id, actor, action, entity, entity_id)
        values (${caller.clinicId}, ${`api_key:${caller.keyId}`}, ${`api_key.refused.${scope}`}, 'api_key', ${caller.keyId})`));
      throw new ForbiddenException({ error: 'forbidden', message: `this key does not have ${scope}` });
    }
    req.apiKey = caller;
    return true;
  }
}
