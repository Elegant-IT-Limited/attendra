// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { type Database, withClinic } from '../client';

export const API_SCOPES = ['schedule:read', 'requests:read', 'requests:write', 'quality:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKey { id: string; name: string; prefix: string; scopes: ApiScope[]; expiresAt: Date; createdByUserId: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }
/** A key that checked out: who it is, for which clinic, and what it may do. */
export interface ApiCaller { keyId: string; clinicId: string; scopes: ApiScope[]; createdByUserId: string }

/** The roles that may hold a key: a key works only while the person who made it is still one of these at the clinic. */
export const KEY_HOLDER_ROLES = ['owner', 'admin'] as const;
const holder = sql`exists (select 1 from memberships m join clinics c on c.org_id = m.organization_id
  where c.id = api_keys.clinic_id and m.user_id = api_keys.created_by_user_id and m.role in ('owner', 'admin'))`;

const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');
const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];
const toKey = (r: Record<string, unknown>): ApiKey => ({
  id: String(r.id), name: String(r.name), prefix: String(r.prefix), scopes: r.scopes as ApiScope[], expiresAt: new Date(r.expires_at as string),
  createdByUserId: String(r.created_by_user_id), createdAt: new Date(r.created_at as string),
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string) : null, revokedAt: r.revoked_at ? new Date(r.revoked_at as string) : null,
});

/** API keys: made and revoked by owners and managers, audited, and never stored in a form that works. */
export class ApiKeyRepository {
  constructor(private readonly db: Database) {}

  /** A new key. The returned `key` is the only copy there will ever be. */
  async create(clinicId: string, k: { name: string; scopes: ApiScope[]; expiresAt: Date; userId: string }): Promise<{ id: string; key: string }> {
    const key = `atk_${randomBytes(32).toString('base64url')}`;
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = rows<{ id: string }>(await tx.execute(sql`insert into api_keys (clinic_id, name, prefix, key_hash, scopes, expires_at, created_by_user_id)
        values (${clinicId}, ${k.name}, ${key.slice(0, 12)}, ${hashOf(key)}, string_to_array(${k.scopes.join(',')}, ','), ${k.expiresAt.toISOString()}::timestamptz, ${k.userId}) returning id`));
      await tx.execute(sql`insert into audit_logs (clinic_id, actor, action, entity, entity_id) values (${clinicId}, ${`user:${k.userId}`}, 'api_key.created', 'api_key', ${row!.id})`);
      return { id: row!.id, key };
    });
  }

  async list(clinicId: string): Promise<ApiKey[]> {
    return withClinic(this.db, clinicId, async (tx) => rows<Record<string, unknown>>(await tx.execute(sql`select * from api_keys where clinic_id = ${clinicId} order by created_at desc`)).map(toKey));
  }

  async revoke(clinicId: string, id: string, userId: string): Promise<boolean> {
    return withClinic(this.db, clinicId, async (tx) => {
      const done = rows<{ id: string }>(await tx.execute(sql`update api_keys set revoked_at = now() where clinic_id = ${clinicId} and id = ${id} and revoked_at is null returning id`));
      if (done.length) await tx.execute(sql`insert into audit_logs (clinic_id, actor, action, entity, entity_id) values (${clinicId}, ${`user:${userId}`}, 'api_key.revoked', 'api_key', ${id})`);
      return done.length > 0;
    });
  }
}

/**
 * Finds the key a request carries, by its hash, before the clinic is known (owner
 * connection). Null for anything that is not a live key: unknown, revoked, expired,
 * or made by someone who is no longer an owner or practice manager at the clinic.
 */
export async function authenticateApiKey(db: Database, key: string, now = new Date()): Promise<ApiCaller | null> {
  if (!/^atk_[A-Za-z0-9_-]{43}$/.test(key)) return null;
  const [r] = rows<{ id: string; clinic_id: string; scopes: ApiScope[]; created_by_user_id: string; expires_at: string | Date; revoked_at: string | null }>(
    await db.execute(sql`select id, clinic_id, scopes, created_by_user_id, expires_at, revoked_at from api_keys where key_hash = ${hashOf(key)} and ${holder}`));
  if (!r || r.revoked_at || new Date(r.expires_at) <= now) return null;
  return { keyId: r.id, clinicId: r.clinic_id, scopes: r.scopes, createdByUserId: r.created_by_user_id };
}

/**
 * Is a key that authenticated still live, right now? Checked again before every tool
 * call, so a key revoked while a client is connected stops at its next call.
 */
export async function apiKeyIsLive(db: Database, caller: ApiCaller, now = new Date()): Promise<boolean> {
  const [r] = rows<{ expires_at: string | Date; revoked_at: string | null }>(
    await db.execute(sql`select expires_at, revoked_at from api_keys where id = ${caller.keyId} and clinic_id = ${caller.clinicId} and ${holder}`));
  return !!r && !r.revoked_at && new Date(r.expires_at) > now;
}

/** Every use of a key, audited in the clinic with the key's id: mcp.<tool>. */
export async function auditKeyUse(db: Database, caller: ApiCaller, tool: string, counts?: Record<string, number>) {
  await withClinic(db, caller.clinicId, async (tx) => {
    await tx.execute(sql`insert into audit_logs (clinic_id, actor, action, entity, entity_id, counts) values
      (${caller.clinicId}, ${`api_key:${caller.keyId}`}, ${`mcp.${tool}`}, 'api_key', ${caller.keyId}, ${counts ? JSON.stringify(counts) : null}::jsonb)`);
    await tx.execute(sql`update api_keys set last_used_at = now() where clinic_id = ${caller.clinicId} and id = ${caller.keyId}`);
  });
}
