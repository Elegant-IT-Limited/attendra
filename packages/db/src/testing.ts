// SPDX-License-Identifier: AGPL-3.0-only
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { Database } from './client';
import { migrate } from './migrate';
import * as schema from './schema';

/**
 * A real PostgreSQL running in-process (PGlite), migrated with the same files a
 * deploy uses. Used by tests and the eval simulator; never by the running service.
 *
 * With ATTENDRA_TEST_DATABASE_URL set (CI's "postgres" job, on the production image), a
 * fresh database on that server instead, dropped at close: the same tests on the same
 * Postgres, roles and row-level security production runs (tester finding 2, 2026-11-04:
 * a profile save that PGlite never failed).
 */
export async function openTestDatabase(): Promise<{ db: Database; client: PGlite; close: () => Promise<void> }> {
  const url = process.env.ATTENDRA_TEST_DATABASE_URL;
  if (url) return openServerTestDatabase(url);
  const client = new PGlite({ extensions: { btree_gist, vector } });
  await migrate(client);
  // `client` is for pg-boss, which runs its jobs on the same in-process database
  return { db: drizzle(client, { schema }) as unknown as Database, client, close: () => client.close() };
}

async function openServerTestDatabase(url: string): Promise<{ db: Database; client: PGlite; close: () => Promise<void> }> {
  const name = `attendra_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const at = new URL(url);
  at.pathname = `/${name}`;
  const pool = new Pool({ connectionString: at.toString(), max: 5 });
  // the two calls the tests and the migrator make on `client`
  const client = {
    exec: async (text: string) => { await pool.query(text); },
    query: async (text: string, params?: unknown[]) => pool.query(text, params as unknown[]),
  };
  await migrate(client as never);
  return {
    db: drizzlePg(pool, { schema }) as unknown as Database,
    client: client as unknown as PGlite,
    close: async () => {
      await pool.end();
      const drop = new Client({ connectionString: url });
      await drop.connect();
      await drop.query(`drop database if exists ${name} with (force)`);
      await drop.end();
    },
  };
}

// A fixed, obviously fake key. Tests only; never reuse outside this file.
export const TEST_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
