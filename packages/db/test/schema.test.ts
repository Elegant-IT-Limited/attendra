import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { schema } from '../src';
import * as auth from '../src/auth-schema';
import { openTestDatabase } from '../src/testing';

let t: Awaited<ReturnType<typeof openTestDatabase>>;
beforeAll(async () => { t = await openTestDatabase(); });
afterAll(() => t.close());

it('describes every table and column the migrations create, so no query needs raw SQL for want of a column', async () => {
  const defined = new Map<string, string[]>();
  for (const v of [...Object.values(schema), ...Object.values(auth)]) {
    if (is(v, PgTable)) { const c = getTableConfig(v); defined.set(c.name, c.columns.map((x) => x.name).sort()); }
  }
  // the migrator's own bookkeeping, not an Attendra table
  const rows = (await t.db.execute(sql`select c.table_name, c.column_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.table_name <> 'schema_migrations'`)).rows as { table_name: string; column_name: string }[];
  const live = new Map<string, string[]>();
  for (const r of rows) live.set(r.table_name, [...(live.get(r.table_name) ?? []), r.column_name]);
  for (const [table, columns] of live) expect(defined.get(table), table).toEqual(columns.sort());
});
