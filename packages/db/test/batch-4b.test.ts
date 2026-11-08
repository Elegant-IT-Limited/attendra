import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMembership, CallRepository, createPhiCipher, FrontDeskRepository, PostgresTaskQueue, schema, seedDemo, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

// Batch 4b (migration 0055): how a call went for the caller, the Calls list's emergency-result filter, and reopening a
// request with its history. Made-up demo data only.
const cipher = createPhiCipher(TEST_DATA_KEY);
const clinic = DEMO_CLINIC.id;
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let desk: FrontDeskRepository;

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  await t.owner.execute(sql`insert into auth_users (id, name, email, email_verified) values ('u_jordan', 'Jordan Lee', 'jordan@example.test', true)`);
  await addMembership(t.db, 'org_demo', 'u_jordan', 'staff');
  desk = new FrontDeskRepository(t.db, cipher);
});
afterAll(() => t.close());

describe('the call markers (CALL-3, migration 0055)', () => {
  it('are kept on the call at close and shown on its page; a call closed without them leaves them empty', async () => {
    const calls = new CallRepository(t.db, cipher);
    const measured = await calls.open(clinic, 'rtc_markers_1', '+15555550134', 'phone');
    await calls.close(clinic, measured, { reason: 'caller_hangup', voiceSeconds: 50, outcome: 'info', emergency: false, quality: { firstAudioMs: 800, stalls: 0, answerTimeouts: 0, maxGapMs: 2400, repeatedQuestions: 1 } });
    expect(await desk.getCall(clinic, measured, 'u_jordan')).toMatchObject({ maxGapMs: 2400, repeatedQuestions: 1 });
    const unmeasured = await calls.open(clinic, 'rtc_markers_2', '+15555550135', 'phone');
    await calls.close(clinic, unmeasured, { reason: 'caller_hangup', voiceSeconds: 10, outcome: 'info', emergency: false, quality: { firstAudioMs: 800, stalls: 0, answerTimeouts: 0 } });
    expect(await desk.getCall(clinic, unmeasured, 'u_jordan')).toMatchObject({ maxGapMs: null, repeatedQuestions: null });
    await expect(withClinic(t.db, clinic, (tx) => tx.execute(sql`update calls set max_gap_ms = -1 where id = ${measured}`))).rejects.toThrow();
  });
});

describe('the Calls list filtered by how an emergency ended (CALL-2)', () => {
  it('returns only the calls with that result, newest first, and pages through them', async () => {
    const calls = new CallRepository(t.db, cipher);
    const ids: string[] = [];
    for (const [i, result] of (['transferred', 'hospital_said', 'transferred', 'cleared'] as const).entries()) {
      const id = await calls.open(clinic, `rtc_er_${i}`, `+1555555014${i}`, 'phone');
      await t.owner.execute(sql`update calls set started_at = ${new Date(Date.UTC(2026, 10, 1, 9, i))} where id = ${id}`);
      await calls.close(clinic, id, { reason: 'caller_hangup', voiceSeconds: 30, outcome: 'emergency', emergency: true, emergencyResult: result });
      ids.push(id);
    }
    const first = await desk.listCalls(clinic, { limit: 1, emergencyResult: 'transferred' });
    expect(first.map((c) => [c.id, c.emergencyResult])).toEqual([[ids[2], 'transferred']]);
    const next = await desk.listCalls(clinic, { limit: 1, emergencyResult: 'transferred', before: { startedAt: first[0]!.cursor, id: first[0]!.id } });
    expect(next.map((c) => c.id)).toEqual([ids[0]]);
    expect((await desk.listCalls(clinic, { limit: 10, emergencyResult: 'cleared' })).map((c) => c.id)).toEqual([ids[3]]);
  });

  it('uses an index for the outcome, the emergency result and the browser-test filters', async () => {
    const indexes = (await t.owner.execute(sql`select indexname from pg_indexes where tablename in ('calls', 'audit_logs')`)).rows.map((r: unknown) => (r as { indexname: string }).indexname);
    expect(indexes).toEqual(expect.arrayContaining(['calls_by_outcome', 'calls_by_emergency_result', 'calls_browser_tests', 'audit_logs_task_history']));
  });
});

describe('reopening a request (REQ-3) and its history', () => {
  it('opens a closed request again, unclaimed and with no outcome, audited and in its history', async () => {
    const { id } = await new PostgresTaskQueue(t.db, cipher).create(clinic, { type: 'callback', callId: null, patientId: null, idempotencyKey: 'agent:reopen', details: { reason: 'call back about Biscuit' } });
    expect(await desk.claimTask(clinic, id, 'u_jordan')).toBe('claimed');
    expect(await desk.completeTask(clinic, id, 'u_jordan', 'called_back')).toBe('done');
    // an open request is not reopened
    expect(await desk.reopenTask(clinic, id, 'u_jordan')).toBe('reopened');
    expect(await desk.reopenTask(clinic, id, 'u_jordan')).toBe('taken');
    expect(await desk.reopenTask(clinic, '00000000-0000-4000-8000-000000000000', 'u_jordan')).toBe('not_found');
    const [row] = await withClinic(t.db, clinic, (tx) => tx.select().from(schema.tasks).where(sql`${schema.tasks.id} = ${id}`));
    expect(row).toMatchObject({ status: 'open', doneAt: null, doneByUserId: null, outcome: null, assigneeUserId: null, claimedAt: null });
    // a view is who read it, not what happened to it: never in the history
    await desk.listTasks(clinic, { status: 'open', limit: 10 }, 'u_jordan');
    const history = await desk.taskHistory(clinic, id);
    expect(history!.map((h) => [h.action, h.actor])).toEqual([
      ['task.created.callback', 'voice-agent'], ['task.claimed', 'user:u_jordan'], ['task.done', 'user:u_jordan'], ['task.reopened', 'user:u_jordan'],
    ]);
    expect(await desk.taskHistory(clinic, '00000000-0000-4000-8000-000000000000')).toBeNull();
    // it can be closed again, by anyone now that nobody holds it
    expect(await desk.completeTask(clinic, id, 'u_jordan', null)).toBe('done');
  });
});
