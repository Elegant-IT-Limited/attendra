import { CEDAR_PARK_CLINIC, DEMO_CLINIC, providerEvent } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallEventLog, callEventsOf, callNumbers, CallRepository, createPhiCipher, type Database, findCallEvents, purgeCallEvents, seedCedarPark, seedDemo } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

// Foundation A, item 2: the per-call event log. Stored per clinic only (row-level security), kept 7 days, and never
// anything a caller or the assistant said.
const cipher = createPhiCipher(TEST_DATA_KEY);
const A = DEMO_CLINIC.id;
const B = CEDAR_PARK_CLINIC.id;
const SAID = 'Hi, this is Maria Delgado, my number is 303 555 0147';
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let db: Database;
let callA: string;

beforeAll(async () => {
  t = await openTestDatabase({ as: 'service' });
  db = t.db;
  await seedDemo(db, cipher);
  await seedCedarPark(db, cipher);
  callA = await new CallRepository(db, cipher).open(A, 'events_call_a', '+13035550147', 'phone', undefined, undefined, { engine: 'gpt-realtime', voiceFlow: 'tools' });
}, 60_000);
afterAll(async () => { await t?.close(); });

const rowsOf = async (callId: string) => (await t.owner.execute(sql`select * from call_events where call_id = ${callId} order by seq`)).rows as Record<string, unknown>[];

describe('the call event log', () => {
  it('is written in batches, not per event: nothing until a flush, deltas folded into one row', async () => {
    let clock = 0;
    const log = new CallEventLog(db, A, callA, 'gpt-realtime/tools', { flushMs: 60_000, now: () => clock });
    clock = 1200;
    log.add(providerEvent({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_1' }));
    for (let i = 0; i < 5; i++) { clock = 2000 + i * 40; log.add(providerEvent({ type: 'response.output_audio_transcript.delta', response_id: 'resp_1', item_id: 'item_2', delta: `word${i} ` })); }
    log.add({ type: 'gate.sent.reply' });
    expect(await rowsOf(callA)).toEqual([]);
    expect(await log.close()).toEqual({ written: 3, dropped: 0 });
    const rows = await rowsOf(callA);
    expect(rows.map((r) => [r.seq, r.at_ms, r.type, r.n, r.last_ms])).toEqual([
      [0, 1200, 'input_audio_buffer.speech_stopped', 1, null], [1, 2000, 'response.output_audio_transcript.delta', 5, 2160], [2, 2160, 'gate.sent.reply', 1, null],
    ]);
    expect(rows.every((r) => r.path === 'gpt-realtime/tools' && r.clinic_id === A)).toBe(true);
  });

  it('is stored per clinic only: another clinic, or no clinic, sees none of it', async () => {
    expect((await callEventsOf(db, A, callA)).length).toBeGreaterThan(0);
    expect(await callEventsOf(db, B, callA)).toEqual([]);
    const unseen = await db.transaction(async (tx) => { await tx.execute(sql`set local role attendra_app`); return (await tx.execute(sql`select count(*)::int as n from call_events`)).rows[0]; });
    expect(unseen).toEqual({ n: 0 });
    // and B's own scope, on the services' role, finds none of A's rows either
    const asB = await db.transaction(async (tx) => { await tx.execute(sql`select set_config('app.clinic_id', ${B}, true)`); return (await tx.execute(sql`select count(*)::int as n from call_events`)).rows[0]; });
    expect(asB).toEqual({ n: 0 });
  });

  it('never stores content: transcript text, deltas, tool arguments and error messages are dropped before the table', async () => {
    const callId = await new CallRepository(db, cipher).open(A, 'events_call_content', null);
    const log = new CallEventLog(db, A, callId, 'gpt-live/planner', { flushMs: 60_000 });
    log.add(providerEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: SAID }));
    log.add(providerEvent({ type: 'session.input_transcript.delta', event_id: 'e2', delta: SAID, start_ms: 0, end_ms: 900 }));
    log.add(providerEvent({ type: 'response.function_call_arguments.done', call_id: 'call_1', name: 'verify_caller', arguments: JSON.stringify({ owner_name: 'Maria Delgado', phone: '+13035550147' }) }));
    log.add(providerEvent({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', message: `Bad value: ${SAID}` } }));
    // and anything handed to it directly that is not id-shaped
    log.add({ type: SAID, responseId: SAID, itemId: 'Maria Delgado', errorCode: '303 555 0147' });
    expect(await log.close()).toEqual({ written: 5, dropped: 0 });
    // every text column (ids and times are not words: a timestamp may hold "303" by chance)
    const stored = JSON.stringify((await rowsOf(callId)).map((r) => [r.path, r.type, r.response_id, r.item_id, r.error_code, r.error_type]));
    for (const word of ['Maria', 'Delgado', '0147', '303', 'owner_name', 'Bad value']) expect(stored).not.toContain(word);
    expect((await rowsOf(callId)).map((r) => r.type)).toEqual(['conversation.item.input_audio_transcription.completed', 'session.input_transcript.delta', 'response.function_call_arguments.done', 'error', 'unknown']);
    // the table refuses a sentence even from code that skips the checks
    await expect(t.owner.execute(sql`insert into call_events (clinic_id, call_id, path, seq, at_ms, type) values (${A}, ${callId}, 'gpt-live/planner', 9, 0, ${SAID})`)).rejects.toThrow();
    await expect(t.owner.execute(sql`insert into call_events (clinic_id, call_id, path, seq, at_ms, type, item_id) values (${A}, ${callId}, 'gpt-live/planner', 9, 0, 'x', 'Maria Delgado')`)).rejects.toThrow();
    await expect(t.owner.execute(sql`insert into call_events (clinic_id, call_id, path, seq, at_ms, type, error_code) values (${A}, ${callId}, 'gpt-live/planner', 9, 0, 'response.done', 'x')`)).rejects.toThrow();
  });

  it('never fails the call: a write that fails is counted as dropped and reported, and nothing throws', async () => {
    const broken = { transaction: async () => { throw new Error('database down'); } } as unknown as Database;
    const errors: unknown[] = [];
    const log = new CallEventLog(broken, A, callA, 'gpt-realtime/tools', { flushMs: 60_000, onError: (err) => errors.push(err) });
    expect(() => { log.add({ type: 'gate.sent.reply' }); log.add({ type: 'gate.sent.reply' }); }).not.toThrow();
    expect(await log.close()).toEqual({ written: 0, dropped: 2 });
    expect(errors).toHaveLength(1);
    // past the cap, events are dropped, not stored
    const capped = new CallEventLog(db, A, callA, 'gpt-realtime/tools', { flushMs: 60_000, maxRows: 2 });
    for (const type of ['a.one', 'a.two', 'a.three']) capped.add({ type });
    expect(await capped.close()).toEqual({ written: 2, dropped: 1 });
    await t.owner.execute(sql`delete from call_events where type like 'a.%'`);
  });

  it('is found by the call id alone for db:call-events', async () => {
    const found = await findCallEvents(db, callA);
    expect(found).toMatchObject({ clinicId: A, path: 'gpt-realtime/tools' });
    expect(found!.events[0]).toMatchObject({ type: 'input_audio_buffer.speech_stopped', atMs: 1200 });
    expect(await findCallEvents(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('is kept 7 days: the retention purge drops older rows, keeps newer ones, and audits how many', async () => {
    const callId = await new CallRepository(db, cipher).open(A, 'events_call_old', null);
    const log = new CallEventLog(db, A, callId, 'gpt-realtime/tools', { flushMs: 60_000 });
    for (const type of ['old.one', 'old.two', 'old.three', 'new.one']) log.add({ type });
    await log.close();
    await t.owner.execute(sql`update call_events set created_at = now() - interval '8 days' where call_id = ${callId} and type like 'old.%'`);
    expect(await purgeCallEvents(db, A, new Date(Date.now() - 7 * 86_400_000), 2)).toEqual({ callEvents: 3 });
    expect((await rowsOf(callId)).map((r) => r.type)).toEqual(['new.one']);
    const audits = (await t.owner.execute(sql`select counts from audit_logs where clinic_id = ${A} and action = 'retention.purged' and counts ? 'callEvents' order by id`)).rows as { counts: { callEvents: number } }[];
    expect(audits.map((a) => a.counts.callEvents)).toEqual([2, 1]);
    // the other clinic's purge touches none of A's rows
    expect(await purgeCallEvents(db, B, new Date(Date.now() + 60_000))).toEqual({ callEvents: 0 });
    expect(await rowsOf(callId)).toHaveLength(1);
  });

  it('feeds the daily numbers for the clinic\'s own day', async () => {
    const n = await callNumbers(db, cipher, A, null, new Date(Date.now() + 86_400_000));
    expect(n).toMatchObject({ timezone: DEMO_CLINIC.timezone, truncated: false });
    const path = n!.paths.find((p) => p.path === 'gpt-realtime/tools')!;
    expect(path.yesDisagreements.status).toBe('not_measured');
    expect(path.callsWithEventLog).toBeGreaterThan(0);
    expect(await callNumbers(db, cipher, 'clinic_nobody', null)).toBeNull();
  });
});
