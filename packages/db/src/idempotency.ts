// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import type { Database } from './client';

/** How long a key's answer is kept: a client retries within minutes, never a day later. */
export const IDEMPOTENCY_KEPT_HOURS = 24;
/** A request still being answered after this long is taken to have died with its process: the key may be used again. */
export const IDEMPOTENCY_PENDING_MS = 60_000;

export type Claim =
  /** The key is new (or its first request died): answer the request, then `finish` or `release`. */
  | { kind: 'new' }
  /** The same request was answered before: send this again. */
  | { kind: 'replay'; status: number; response: string | null }
  /** The same key is being answered right now (a double click): try again in a moment. */
  | { kind: 'in_progress' }
  /** The key was used for a different request: never answered with the other one's answer. */
  | { kind: 'mismatch' };

/**
 * Takes a key for one request, or says what happened to it before. One statement claims it,
 * so two requests with the same key at the same moment never both run.
 */
export async function claimIdempotencyKey(db: Database, scope: string, key: string, requestHash: string, now = new Date()): Promise<Claim> {
  const stale = new Date(now.getTime() - IDEMPOTENCY_PENDING_MS);
  const expired = new Date(now.getTime() - IDEMPOTENCY_KEPT_HOURS * 3_600_000);
  // a new key, or a dead request's key, or an answer older than kept: this request takes it
  const taken = await db.execute<{ scope: string }>(sql`
    insert into idempotency_keys (scope, key, request_hash, created_at) values (${scope}, ${key}, ${requestHash}, ${now})
    on conflict (scope, key) do update set request_hash = excluded.request_hash, status = null, response = null, created_at = excluded.created_at
      where (idempotency_keys.status is null and idempotency_keys.created_at < ${stale})
         or idempotency_keys.created_at < ${expired}
    returning scope`);
  if (taken.rows.length) return { kind: 'new' };
  const rows = await db.execute<{ request_hash: string; status: number | null; response: string | null }>(sql`
    select request_hash, status, response from idempotency_keys where scope = ${scope} and key = ${key}`);
  const row = rows.rows[0];
  if (!row) return claimIdempotencyKey(db, scope, key, requestHash, now); // removed meanwhile: take it again
  if (row.request_hash !== requestHash) return { kind: 'mismatch' };
  if (row.status === null) return { kind: 'in_progress' };
  return { kind: 'replay', status: row.status, response: row.response };
}

/** Keeps the answer (already encrypted by the caller) for the next time the key comes. */
export async function finishIdempotencyKey(db: Database, scope: string, key: string, status: number, response: string | null) {
  await db.execute(sql`update idempotency_keys set status = ${status}, response = ${response} where scope = ${scope} and key = ${key}`);
}

/** The request failed before an answer worth keeping: the key is free for the retry. */
export async function releaseIdempotencyKey(db: Database, scope: string, key: string) {
  await db.execute(sql`delete from idempotency_keys where scope = ${scope} and key = ${key} and status is null`);
}

/** Answers older than they are kept. Run now and then; nothing depends on it running. */
export async function pruneIdempotencyKeys(db: Database, now = new Date()): Promise<number> {
  const expired = new Date(now.getTime() - IDEMPOTENCY_KEPT_HOURS * 3_600_000);
  const res = await db.execute(sql`delete from idempotency_keys where created_at < ${expired}`);
  return (res as unknown as { rowCount?: number; affectedRows?: number }).rowCount ?? (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
}
