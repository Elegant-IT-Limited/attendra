// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema';

// Any Postgres-backed Drizzle database with our schema: node-postgres in production,
// PGlite in tests. Repositories only ever see this type. The query-result type
// differs between the two drivers, hence the one `any` here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = PgDatabase<any, typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * A pool on a Postgres URL. An idle connection the server drops emits 'error' on the
 * pool, and an EventEmitter with no listener for it ends the process, so there is
 * always one: it reports the error's code, never its message (which can quote a row).
 */
export function connect(url: string, opts: { onError?: (code: string) => void } = {}): Database {
  const pool = new Pool({ connectionString: url, max: 10 });
  const report = opts.onError ?? ((code: string) => process.stderr.write(`${JSON.stringify({ level: 50, msg: 'database connection error', code })}\n`));
  pool.on('error', (err: Error & { code?: string }) => report(err.code ?? 'unknown'));
  return drizzle(pool, { schema });
}

/**
 * The URL a service's queries go to: the services' own role when the deploy gives it one
 * (migration 0051), the owner's otherwise. pg-boss and the migrator keep DATABASE_URL.
 */
export const serviceDatabaseUrl = (env: { DATABASE_URL: string; ATTENDRA_SERVICE_DATABASE_URL?: string }) => env.ATTENDRA_SERVICE_DATABASE_URL ?? env.DATABASE_URL;

/**
 * The role a connection runs as, and whether row-level security can hold it (a superuser or
 * a BYPASSRLS role it cannot). Logged at boot, so a deploy shows which side a service is on,
 * and an error when the services' URL turns out to be a role that gets past it.
 */
export async function connectionRole(db: Database): Promise<{ role: string; bypassesRls: boolean }> {
  const [r] = (await db.execute(sql`select current_user as role, (rolsuper or rolbypassrls) as bypasses from pg_roles where rolname = current_user`)).rows as { role: string; bypasses: boolean }[];
  return { role: r!.role, bypassesRls: r!.bypasses };
}

/** Logs connectionRole at boot; never throws, since the health check reports a database that does not answer. */
export async function logConnectionRole(db: Database, log: { info: (o: object, msg: string) => void; error: (o: object, msg: string) => void }, serviceUrlSet: boolean) {
  const r = await connectionRole(db).catch(() => null);
  if (!r) return;
  if (serviceUrlSet && r.bypassesRls) log.error({ role: r.role }, 'ATTENDRA_SERVICE_DATABASE_URL is a role that gets past row-level security; it should be attendra_service');
  else log.info({ role: r.role, rowLevelSecurity: !r.bypassesRls }, 'database role');
}

/**
 * Runs fn in one transaction, as the application role, scoped to one clinic. Both
 * settings are transaction-local, so a pooled connection never carries a tenant
 * into the next request. This is the second wall; every query also filters on
 * clinic_id itself.
 */
export async function withClinic<T>(db: Database, clinicId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role attendra_app`);
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    return fn(tx);
  });
}

/**
 * Runs fn in one transaction scoped to one clinic, keeping the connecting role: for the
 * system work the application role has no grant for (a purge's deletes, the team tables an
 * API key's check reads). Row-level security still holds it to this clinic's rows on the
 * services' role (migration 0051); the owner, as a superuser, is not held by it.
 */
export async function withClinicScope<T>(db: Database, clinicId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setClinicScope(tx, clinicId);
    return fn(tx);
  });
}

/** Sets the clinic for the rest of a transaction already open, the role left as it is. */
export async function setClinicScope(tx: Tx, clinicId: string) {
  await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
}

/**
 * Whether the database answers a query within `timeoutMs`: for the health check, so a
 * service whose Postgres is down says so instead of "ok". Never throws.
 */
export async function databaseAnswers(db: Database, timeoutMs = 1000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const asked = db.execute(sql`select 1`).then(() => true, () => false);
  return Promise.race([asked, late]).finally(() => clearTimeout(timer));
}
