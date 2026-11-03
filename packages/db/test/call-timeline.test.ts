import { RIVERBEND_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, callTimeline, createPhiCipher, formatCallTimeline, seedRiverbend, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const C = RIVERBEND_CLINIC.id;
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let callId: string;

const LINES = [
  { speaker: 'agent' as const, text: 'Thanks for calling Riverbend Animal Hospital. How can I help?', startMs: 400, endMs: 3900 },
  { speaker: 'caller' as const, text: 'Hi, this is Jordan, my dog Biscuit needs a check-up.', startMs: 5100, endMs: 7800 },
  { speaker: 'agent' as const, text: 'Sure. What phone number is your pet\'s profile under?', startMs: 10600, endMs: 12900 },
  { speaker: 'caller' as const, text: '303 555 0142.', startMs: 13800, endMs: 15200 },
];

beforeAll(async () => {
  t = await openTestDatabase();
  await seedRiverbend(t.db, cipher);
  const calls = new CallRepository(t.db, cipher);
  callId = await calls.open(C, 'sess_timeline', null, 'web');
  // stored out of order on purpose: the timeline is by start time
  for (const s of [LINES[1]!, LINES[0]!, LINES[3]!, LINES[2]!]) await calls.appendSegment(C, callId, s);
});
afterAll(() => t.close());

describe('a call timeline', () => {
  it('gives each line\'s speaker, start, end and length in characters, in order, and never the text', async () => {
    const timeline = await callTimeline(t.db, cipher, callId);
    expect(timeline).toEqual({
      clinicId: C, channel: 'web',
      segments: LINES.map(({ speaker, startMs, endMs, text }) => ({ speaker, startMs, endMs, chars: text.length })),
    });
    const out = formatCallTimeline(callId, timeline!);
    expect(out).toEqual([
      `call ${callId} · clinic ${C} · web · 4 segments`,
      'speaker start_ms end_ms chars gap_ms',
      `agent 400 3900 ${LINES[0]!.text.length} -`,
      `caller 5100 7800 ${LINES[1]!.text.length} 1200`,
      `agent 10600 12900 ${LINES[2]!.text.length} 2800`,
      `caller 13800 15200 ${LINES[3]!.text.length} 900`,
    ]);
    const printed = out.join('\n');
    for (const word of ['Riverbend', 'Jordan', 'Biscuit', 'profile', '0142']) expect(printed).not.toContain(word);
  });

  it('is null for a call no clinic has, refuses an id that is not a UUID, and writes nothing', async () => {
    const before = (await withClinic(t.db, C, (tx) => tx.execute(sql`select count(*)::int as n from audit_logs`))).rows[0];
    expect(await callTimeline(t.db, cipher, '00000000-0000-4000-8000-000000000000')).toBeNull();
    await expect(callTimeline(t.db, cipher, 'not-a-call')).rejects.toThrow('UUID');
    await callTimeline(t.db, cipher, callId);
    expect((await withClinic(t.db, C, (tx) => tx.execute(sql`select count(*)::int as n from audit_logs`))).rows[0]).toEqual(before);
  });
});
