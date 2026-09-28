// SPDX-License-Identifier: AGPL-3.0-only
// Applies pending migrations to DATABASE_URL. Run once per deploy, before the services start.
// One connection with a session advisory lock, so two deploys starting at once cannot both migrate.
import pg from 'pg';
import { migrate } from '../src/migrate';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('select pg_advisory_lock(727070)');
  const applied = await migrate({ exec: (sql) => client.query(sql), query: (sql, params) => client.query(sql, params) as never });
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema up to date');
} finally {
  await client.query('select pg_advisory_unlock(727070)').catch(() => {});
  await client.end();
}
