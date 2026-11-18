import { RIVERBEND_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, phiContext, PostgresTaskQueue, seedRiverbend } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

// Call quality Q7 (2026-11-18): a follow-up about the same request on the call changes that request's details.
const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
const C = RIVERBEND_CLINIC.id;
beforeAll(async () => { t = await openTestDatabase(); await seedRiverbend(t.db, cipher); });
afterAll(() => t.close());

describe('a request\'s details changed on the call that made it', () => {
  it('changes only this call\'s open request, and audits it', async () => {
    const calls = new CallRepository(t.db, cipher);
    const callId = await calls.open(C, 'sess_update_1', null);
    const other = await calls.open(C, 'sess_update_2', null);
    const q = new PostgresTaskQueue(t.db, cipher);
    const task = await q.create(C, { type: 'refill', callId, patientId: null, idempotencyKey: 'k-update-1', details: { medication: 'this' } });
    expect(await q.updateDetails(C, task.id, callId, { medication: 'meloxicam' })).toBe(true);
    expect(await q.updateDetails(C, task.id, other, { medication: 'something else' })).toBe(false);
    const [row] = (await t.owner.execute(sql`select details_enc from tasks where id = ${task.id}`)).rows as { details_enc: string }[];
    expect(JSON.parse(cipher.decrypt(row!.details_enc, phiContext(C, 'tasks.details')))).toEqual({ medication: 'meloxicam' });
    const audit = (await t.owner.execute(sql`select count(*)::int as n from audit_logs where entity_id = ${task.id} and action = 'task.details.updated'`)).rows as { n: number }[];
    expect(audit[0]!.n).toBe(1);
    // done: never changed again
    await t.owner.execute(sql`update tasks set status = 'done' where id = ${task.id}`);
    expect(await q.updateDetails(C, task.id, callId, { medication: 'later' })).toBe(false);
  });
});
