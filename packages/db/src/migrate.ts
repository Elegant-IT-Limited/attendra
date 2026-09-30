// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

export interface SqlRunner {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Applies pending SQL migrations in file order, one transaction each, recorded in
 * schema_migrations. Plain SQL on purpose: the parts that matter here (RLS policies,
 * the exclusion constraint, grants) are the parts generators do not express.
 */
export async function migrate(db: SqlRunner, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await db.query<{ id: string }>('select id from schema_migrations')).rows.map((r) => r.id));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    try {
      await db.exec(`begin;\n${sql}\ninsert into schema_migrations (id) values ('${file.replace(/'/g, "''")}');\ncommit;`);
    } catch (err) {
      // a file that fails leaves nothing behind, and the connection usable
      await db.exec('rollback').catch(() => {});
      throw err;
    }
    applied.push(file);
  }
  return applied;
}
