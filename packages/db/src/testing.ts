// SPDX-License-Identifier: AGPL-3.0-only
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import type { Database } from './client';
import { migrate } from './migrate';
import * as schema from './schema';

/**
 * A real PostgreSQL running in-process (PGlite), migrated with the same files a
 * deploy uses. Used by tests and the eval simulator; never by the running service.
 */
export async function openTestDatabase(): Promise<{ db: Database; client: PGlite; close: () => Promise<void> }> {
  const client = new PGlite({ extensions: { btree_gist, vector } });
  await migrate(client);
  // `client` is for pg-boss, which runs its jobs on the same in-process database
  return { db: drizzle(client, { schema }) as unknown as Database, client, close: () => client.close() };
}

// A fixed, obviously fake key. Tests only; never reuse outside this file.
export const TEST_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
