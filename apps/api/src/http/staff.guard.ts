// SPDX-License-Identifier: AGPL-3.0-only
import { type Database, type StaffRole, staffRole } from '@attendra/db';
import {
  type CanActivate, createParamDecorator, type ExecutionContext, ForbiddenException, Inject, Injectable,
  NotFoundException, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { can, type Permission } from '../access';
import type { Auth } from '../auth';
import { API_OPTIONS, type ApiOptions, AUTH, DB } from './tokens';

export interface Staff {
  userId: string;
  name: string;
  email: string;
  twoFactorEnabled: boolean;
  /** Set on clinic routes, after the membership check. */
  clinicId?: string;
  role?: StaffRole;
}

type StaffRequest = FastifyRequest & { staff?: Staff };

const PERMISSION = 'attendra:permission';
const BEFORE_TWO_FACTOR = 'attendra:before-two-factor';
const PUBLIC = 'attendra:public';

/** The permission a clinic route needs. The route must have a :clinicId parameter. */
export const Requires = (permission: Permission) => SetMetadata(PERMISSION, permission);
/** For the few routes a signed-in person needs before enrolling in two-factor (who am I?). */
export const BeforeTwoFactor = () => SetMetadata(BEFORE_TWO_FACTOR, true);
/** No session needed. Only the health check, which carries no data. */
export const Public = () => SetMetadata(PUBLIC, true);

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
 * two-factor must be on, and on clinic routes the person must be a member of the
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
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<StaffRequest>();
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T | undefined>(key, [ctx.getHandler(), ctx.getClass()]);
    if (meta<boolean>(PUBLIC)) return true;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== new URL(this.options.publicUrl).origin) {
      throw new ForbiddenException({ error: 'cross_origin_write' });
    }

    const session = await this.auth.api.getSession({ headers: toHeaders(req.headers) });
    if (!session) throw new UnauthorizedException({ error: 'signed_out' });
    const user = session.user as typeof session.user & { twoFactorEnabled?: boolean | null };
    req.staff = { userId: user.id, name: user.name, email: user.email, twoFactorEnabled: !!user.twoFactorEnabled };

    const beforeTwoFactor = meta<boolean>(BEFORE_TWO_FACTOR);
    if (!beforeTwoFactor && !this.options.demoMode && !req.staff.twoFactorEnabled) {
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
}
