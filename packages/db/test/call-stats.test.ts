import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, callStats, createPhiCipher, formatCallStats, groupCallStats, seedDemo, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let calls: CallRepository;
const since = new Date(Date.now() - 3_600_000);

/** Places a tool action this many ms after the call started (the action's own clock). */
const actionAt = (callId: string, tool: string, ms: number, result: unknown = { ok: true }) => withClinic(t.db, DEMO_CLINIC.id, (tx) =>
  tx.execute(sql`insert into call_actions (clinic_id, call_id, tool, args_redacted, result, task_revision, created_at)
    select ${DEMO_CLINIC.id}, ${callId}, ${tool}, '[]'::jsonb, ${JSON.stringify(result)}::jsonb, 1, started_at + make_interval(secs => ${ms / 1000}) from calls where id = ${callId}`));

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  calls = new CallRepository(t.db, cipher);
});
afterAll(() => t.close());

describe('db:call-stats', () => {
  it('measures a call before 1a: voice-only turns, and the lookup answer estimated past the filler', async () => {
    const id = await calls.open(DEMO_CLINIC.id, 'live_stats_1', null, 'phone', undefined, null, { engine: 'gpt-live', voiceFlow: 'planner' });
    const line = (speaker: 'caller' | 'agent', text: string, startMs: number, endMs: number) => calls.appendSegment(DEMO_CLINIC.id, id, { speaker, text, startMs, endMs });
    await line('agent', 'Thanks for calling Maple Street. How can I help you today?', 500, 3000);
    await line('caller', 'Hi, what time do you close today?', 3500, 5000);
    await line('agent', 'We close at five today. Is there anything else?', 5600, 8000); // voice-only: 600 ms
    await line('caller', 'Is Thursday at four free for Biscuit?', 9000, 11_000);
    await line('agent', 'Let me check.', 11_400, 12_000); // filler, not the answer
    await line('agent', 'Thursday at four is free with Dr. Okafor. Shall I book it?', 13_500, 16_000); // answer: 2,500 ms
    await line('agent', 'Shall I book it?', 16_100, 17_000);
    await actionAt(id, 'find_slots', 12_500);
    await calls.close(DEMO_CLINIC.id, id, { reason: 'caller_hangup', voiceSeconds: 20, outcome: 'info', emergency: false, quality: { firstAudioMs: 400, stalls: 0, answerTimeouts: 0 } });
    const [row] = await callStats(t.db, cipher, { clinicIds: [DEMO_CLINIC.id], since });
    expect(row).toMatchObject({ engine: 'gpt-live', voiceFlow: 'planner', voiceOnlyMs: [600], lookupMs: [2500], lookupEstimated: true, fillerLines: 1, repeatedQuestions: 1, actions: 1, empty: false, firstAudioMs: 400 });
  });

  it('measures a call from 1a by its answer_timing rows, and counts an empty one', async () => {
    const id = await calls.open(DEMO_CLINIC.id, 'rtc_stats_2', null, 'web', 'user_x', null, { engine: 'gpt-realtime', voiceFlow: 'tools' });
    await calls.appendSegment(DEMO_CLINIC.id, id, { speaker: 'agent', text: 'Thanks for calling. How can I help?', startMs: 300, endMs: 2000 });
    await calls.appendSegment(DEMO_CLINIC.id, id, { speaker: 'caller', text: 'Is 4 PM free on Friday?', startMs: 2500, endMs: 4000 });
    await calls.appendSegment(DEMO_CLINIC.id, id, { speaker: 'agent', text: 'Yes, Friday at 4 PM is free. Shall I book it?', startMs: 4900, endMs: 7000 });
    await actionAt(id, 'find_slots', 4200);
    await actionAt(id, 'answer_timing', 4900, { wait_ms: 900, tools: 1 });
    await calls.close(DEMO_CLINIC.id, id, { reason: 'session_closed', voiceSeconds: 8, outcome: 'info', emergency: false });
    const silent = await calls.open(DEMO_CLINIC.id, 'live_stats_3', null, 'phone', undefined, null, { engine: 'gpt-live', voiceFlow: 'tools' });
    await calls.close(DEMO_CLINIC.id, silent, { reason: 'remote_hangup', voiceSeconds: 30, outcome: 'no_audio', emergency: false, quality: { firstAudioMs: null, stalls: 0, answerTimeouts: 0 } });
    const rows = await callStats(t.db, cipher, { clinicIds: [DEMO_CLINIC.id], since });
    const tools = rows.find((r) => r.id === id)!;
    expect(tools).toMatchObject({ lookupMs: [900], lookupEstimated: false, voiceOnlyMs: [], actions: 1 });
    expect(rows.find((r) => r.id === silent)).toMatchObject({ empty: true, noAudio: true, segments: 0 });
    const groups = groupCallStats(rows);
    expect(groups.map((g) => g.key)).toEqual([
      `${DEMO_CLINIC.id} · phone · gpt-live · planner`, `${DEMO_CLINIC.id} · web · gpt-realtime · tools`, `${DEMO_CLINIC.id} · phone · gpt-live · tools`,
    ]);
    expect(groups.every((g) => g.costUsd >= 0)).toBe(true);
  });

  it('prints numbers and id prefixes only, never a word of a transcript', async () => {
    const rows = await callStats(t.db, cipher, { clinicIds: [DEMO_CLINIC.id], since });
    const text = formatCallStats(rows, { perCall: true }).join('\n');
    expect(text).toContain('lookup answer ms');
    for (const word of ['Biscuit', 'Thursday', 'Okafor', 'close today', 'Friday']) expect(text).not.toContain(word);
  });
});
