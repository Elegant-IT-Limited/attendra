// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from 'node:async_hooks';

/** The database time one request spent so far: the sum of its queries' times (they can overlap), and how many. */
export interface DbTime { ms: number; queries: number }

const current = new AsyncLocalStorage<DbTime>();
const TIMED = Symbol('attendra.timed');

/** Runs fn with a fresh DbTime that every query started inside it (however deep) adds to. Returns that DbTime. */
export function measureDb(fn: () => void): DbTime {
  const time: DbTime = { ms: 0, queries: 0 };
  current.run(time, fn);
  return time;
}

/** The DbTime of whatever is running now, if something is measuring it. */
export const dbTimeNow = (): DbTime | undefined => current.getStore();

/**
 * Times every query a driver object runs (a pg Pool or client, PGlite or one of its transactions): its `query`
 * method is wrapped once, in place, so promise-returning calls add their time to the request measuring them.
 * Calls with a callback, and calls outside a measured request, pass straight through. Times only: no SQL, no values.
 */
export function timeQueries<T extends object>(driver: T): T {
  const d = driver as T & { query?: (...args: unknown[]) => unknown; [TIMED]?: true };
  if (typeof d.query !== 'function' || d[TIMED]) return driver;
  const query = d.query;
  d.query = function timed(this: unknown, ...args: unknown[]) {
    const time = current.getStore();
    const started = performance.now();
    const out = query.apply(this, args);
    if (!time || !out || typeof (out as Promise<unknown>).then !== 'function') return out;
    const done = () => { time.ms += performance.now() - started; time.queries += 1; };
    (out as Promise<unknown>).then(done, done);
    return out;
  };
  d[TIMED] = true;
  return driver;
}

/** timeQueries for a pg Pool: its own queries, and every client it hands out (a transaction runs on one). */
export function timePool<P extends { on: (event: 'connect', listener: (client: object) => void) => unknown }>(pool: P): P {
  timeQueries(pool);
  pool.on('connect', (client) => { timeQueries(client); });
  return pool;
}

/** timeQueries for PGlite: its own queries, and each transaction's. */
export function timePglite<P extends object>(db: P): P {
  timeQueries(db);
  const transaction = (db as unknown as { transaction: (fn: (tx: object) => Promise<unknown>) => Promise<unknown> }).transaction.bind(db) as (fn: (tx: object) => Promise<unknown>) => Promise<unknown>;
  (db as { transaction: unknown }).transaction = (fn: (tx: object) => Promise<unknown>) => transaction((tx) => fn(timeQueries(tx)));
  return db;
}
