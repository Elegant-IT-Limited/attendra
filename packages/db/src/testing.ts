// SPDX-License-Identifier: AGPL-3.0-only
import { PGlite, type QueryOptions, type Transaction } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { Database } from './client';
import { migrate } from './migrate';
import * as schema from './schema';
import { timePglite, timePool } from './timing';

/**
 * A real PostgreSQL running in-process (PGlite), migrated with the same files a
 * deploy uses. Used by tests and the eval simulator; never by the running service.
 *
 * With ATTENDRA_TEST_DATABASE_URL set (CI's "postgres" job, on the production image), a
 * fresh database on that server instead, dropped at close: the same tests on the same
 * Postgres, roles and row-level security production runs (tester finding 2, 2026-11-04:
 * a profile save that PGlite never failed).
 */
export async function openTestDatabase(opts: { as?: 'owner' | 'service' } = {}): Promise<TestDatabase> {
  const service = (opts.as ?? (asService() ? 'service' : 'owner')) === 'service';
  const url = process.env.ATTENDRA_TEST_DATABASE_URL;
  if (url) return openServerTestDatabase(url, service);
  const pglite = new PGlite({ extensions: { btree_gist, vector } });
  await migrate(pglite);
  // each request's database time, as production's pool gives it (timing.ts)
  const db = drizzle(timePglite(pglite), { schema }) as unknown as Database;
  if (!service) return { db, owner: db, client: pglite, close: () => pglite.close() };
  // ATTENDRA_TEST_AS=service: the session runs as the services' role (0051), with no way past row-level
  // security; `client` and `owner` step back to the owner one transaction at a time, as a second connection would
  await pglite.exec('set role attendra_service');
  const client = ownerSide(pglite);
  return { db, owner: drizzle(client, { schema }) as unknown as Database, client, close: () => pglite.close() };
}

/**
 * What a test gets. `db` is the connection the code under test uses: the owner's, or with
 * ATTENDRA_TEST_AS=service the services' role. `owner` and `client` are always the owner's:
 * `client` for pg-boss (which production runs on the owner's URL: it creates and upgrades its
 * own schema) and raw SQL, `owner` for fixtures a test writes directly. Never the code under test.
 */
export interface TestDatabase { db: Database; owner: Database; client: PGlite; close: () => Promise<void> }

/**
 * The in-process database, as its owner. PGlite is one connection, so each call is its own
 * transaction that sets the role back (`set local role none`) and ends with it: the session
 * stays the services' role in between, and a failed call cannot leave it as the owner.
 */
function ownerSide(pglite: PGlite): PGlite {
  const asOwner = <T>(fn: (tx: Transaction) => Promise<T>) => pglite.transaction(async (tx) => { await tx.exec('set local role none'); return fn(tx); });
  return new Proxy(pglite, {
    get(target, key) {
      if (key === 'query') return (text: string, params?: unknown[], opts?: QueryOptions) => asOwner((tx) => tx.query(text, params, opts));
      if (key === 'exec') return (text: string, opts?: QueryOptions) => asOwner((tx) => tx.exec(text, opts));
      if (key === 'transaction') return <T>(fn: (tx: Transaction) => Promise<T>) => asOwner(fn);
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function openServerTestDatabase(url: string, service: boolean): Promise<TestDatabase> {
  const name = `attendra_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  // Roles belong to the whole server, not one database: two test files migrating at once (0051 grants to
  // attendra_service, then its password below) change the same role and Postgres refuses one ("tuple
  // concurrently updated"). Each file's role work waits its turn on a lock taken in the server's base database.
  await admin.query('select pg_advisory_lock($1)', [ROLE_SETUP_LOCK]);
  try {
    return await openMigrated(url, name, service);
  } finally {
    await admin.query('select pg_advisory_unlock($1)', [ROLE_SETUP_LOCK]).catch(() => {});
    await admin.end();
  }
}

/** The lock the test databases on one server take in turn while they change the shared roles. */
const ROLE_SETUP_LOCK = 51_051;

async function openMigrated(url: string, name: string, service: boolean): Promise<TestDatabase> {
  const at = new URL(url);
  at.pathname = `/${name}`;
  const ownerUrl = at.toString();
  const pool = new Pool({ connectionString: ownerUrl, max: 5 });
  // what the tests, the migrator and pg-boss call on `client`, as PGlite answers them: `exec` one result
  // per statement, `listen` on a connection of its own (the change notices)
  const listeners: Client[] = [];
  const client = {
    exec: async (text: string) => ([] as { rows: unknown[] }[]).concat((await pool.query(text)) as never).map((r) => ({ rows: r.rows ?? [] })),
    query: async (text: string, params?: unknown[]) => pool.query(text, params as unknown[]),
    listen: async (channel: string, callback: (payload: string) => void) => {
      const listener = new Client({ connectionString: ownerUrl });
      await listener.connect();
      listener.on('notification', (n) => { if (n.channel === channel) callback(n.payload ?? ''); });
      await listener.query(`listen "${channel.replace(/"/g, '""')}"`);
      listeners.push(listener);
      return async () => { await listener.end(); };
    },
  };
  await migrate(client as never);
  // ATTENDRA_TEST_AS=service: the services' role (0051), logging in as production's services do
  let served = pool;
  if (service) {
    await pool.query(`alter role attendra_service login password '${SERVICE_TEST_PASSWORD}'`);
    at.username = 'attendra_service';
    at.password = SERVICE_TEST_PASSWORD;
    served = new Pool({ connectionString: at.toString(), max: 5 });
  }
  return {
    db: drizzlePg(timePool(served), { schema }) as unknown as Database,
    owner: drizzlePg(pool, { schema }) as unknown as Database,
    client: client as unknown as PGlite,
    close: async () => {
      await Promise.all(listeners.map((l) => l.end().catch(() => {})));
      if (served !== pool) await served.end();
      await pool.end();
      const drop = new Client({ connectionString: url });
      await drop.connect();
      await drop.query(`drop database if exists ${name} with (force)`);
      await drop.end();
    },
  };
}

/**
 * Whether the tests run as the services' role rather than the database's owner (CI's "service role"
 * pass). A test that is about that role asks for it with `openTestDatabase({ as: 'service' })`.
 */
export const asService = () => process.env.ATTENDRA_TEST_AS === 'service';
// a test database's own password for that role, made up here; production's is set by the deploy
const SERVICE_TEST_PASSWORD = 'service-role-test-only';

// A fixed, obviously fake key. Tests only; never reuse outside this file.
export const TEST_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
