// SPDX-License-Identifier: AGPL-3.0-only
// Seeds a Postgres database for a demo deployment (docker compose runs it when
// ATTENDRA_DEMO_MODE=true). Runs once: a database that already has calls is left alone.
// The demo logins share one password, ATTENDRA_DEMO_PASSWORD. It has no default and
// is never printed: a demo that can take real calls is on the internet.
import { connect, createPhiCipher } from '@attendra/db';
import { sql } from 'drizzle-orm';
import { createAuth } from '../src/auth';
import { loadEnv } from '../src/config';
import { DEMO_LOGINS, seedDemoWorkspace } from './demo-data';

const env = loadEnv();
if (!env.ATTENDRA_DEMO_MODE) {
  console.error('demo-seed runs only with ATTENDRA_DEMO_MODE=true');
  process.exit(2);
}
const password = process.env.ATTENDRA_DEMO_PASSWORD ?? '';
if (password.length < 12) {
  console.error('set ATTENDRA_DEMO_PASSWORD (12 characters or more) for the demo logins');
  process.exit(2);
}
const db = connect(env.DATABASE_URL);
const [{ n }] = (await db.execute(sql`select count(*)::int as n from calls`)).rows as [{ n: number }];
if (n > 0) {
  console.log('demo data already present; nothing to do');
  process.exit(0);
}
const results = await seedDemoWorkspace(db, createPhiCipher(env.ATTENDRA_DATA_KEY), createAuth(db, { publicUrl: env.PUBLIC_URL, secret: env.BETTER_AUTH_SECRET }), password);
console.log(`recorded ${results.length} demo calls; sign in as ${DEMO_LOGINS.map((l) => l.email).join(' or ')}`);
process.exit(0);
