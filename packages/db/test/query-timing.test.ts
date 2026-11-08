// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTimeNow, measureDb, withClinic } from '../src';
import { openTestDatabase, type TestDatabase } from '../src/testing';

let t: TestDatabase;
beforeAll(async () => { t = await openTestDatabase(); });
afterAll(() => t.close());

describe('each request\'s database time (Server-Timing db)', () => {
  it('counts every query started inside a measure, a transaction\'s too, and nothing outside it', async () => {
    let done!: Promise<void>;
    const time = measureDb(() => {
      done = (async () => {
        await t.db.execute(sql`select 1`);
        await withClinic(t.db, 'clinic_timing', async (tx) => { await tx.execute(sql`select 2`); });
      })();
    });
    await done;
    // select 1, then the transaction's begin, its two settings, select 2 and commit
    expect(time.queries).toBeGreaterThanOrEqual(4);
    expect(time.ms).toBeGreaterThan(0);
    const before = time.queries;
    await t.db.execute(sql`select 3`); // outside: not counted
    expect(time.queries).toBe(before);
    expect(dbTimeNow()).toBeUndefined();
  });

  it('keeps two requests running at once apart', async () => {
    let a!: Promise<unknown>; let b!: Promise<unknown>;
    // a Drizzle query runs when it is awaited, so each is awaited inside its own request, as a route does
    const one = measureDb(() => { a = (async () => t.db.execute(sql`select 1`))(); });
    const two = measureDb(() => { b = Promise.all([t.db.execute(sql`select 1`), t.db.execute(sql`select 2`)]); });
    await Promise.all([a, b]);
    expect([one.queries, two.queries]).toEqual([1, 2]);
  });
});
