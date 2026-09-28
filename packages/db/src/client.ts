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

export function connect(url: string): Database {
  return drizzle(new Pool({ connectionString: url, max: 10 }), { schema });
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
