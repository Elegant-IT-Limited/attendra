import { callCost, CALL_RATES, DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, schema, seedDemo, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let calls: CallRepository;

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  calls = new CallRepository(t.db, cipher);
});
afterAll(() => t.close());

describe('call records from any engine (migration 0045)', () => {
  it('keeps the engine, its own session id and the voice flow on the call row', async () => {
    const id = await calls.open(DEMO_CLINIC.id, 'rtc_test_engine_1', '+13035550142', 'phone', undefined, null, { engine: 'gpt-realtime', voiceFlow: 'tools' });
    const [row] = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select({ engine: schema.calls.engine, sid: schema.calls.engineSessionId, flow: schema.calls.voiceFlow }).from(schema.calls).where(sql`id = ${id}`));
    expect(row).toEqual({ engine: 'gpt-realtime', sid: 'rtc_test_engine_1', flow: 'tools' });
  });

  it('writes what a call cost when it closes: the engine\'s minutes, the models\' tokens, its texts and the line', async () => {
    const id = await calls.open(DEMO_CLINIC.id, 'live_test_cost_1', '+13035550143', 'phone', undefined, null, { engine: 'gpt-live', voiceFlow: 'planner' });
    await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.insert(schema.smsMessages).values([
      { clinicId: DEMO_CLINIC.id, template: 'booking_confirmed', toHash: 'h', status: 'sent', idempotencyKey: 'k1', callId: id },
      { clinicId: DEMO_CLINIC.id, template: 'directions', toHash: 'h', status: 'not_sent', idempotencyKey: 'k2', callId: id },
    ]));
    const models = { 'gpt-6-luna': { input: 20_000, cached: 12_000, output: 900 } };
    await calls.close(DEMO_CLINIC.id, id, { reason: 'caller_hangup', voiceSeconds: 120, outcome: 'booked', emergency: false, usage: { models } });
    const [cost] = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.callCosts).where(sql`call_id = ${id}`));
    const expected = callCost({ engine: 'gpt-live', channel: 'phone', voiceSeconds: 120, models, texts: 1 });
    expect(cost).toMatchObject({ engine: 'gpt-live', texts: 1, ratesVersion: CALL_RATES.version, modelTokens: models });
    expect(Number(cost!.voiceUsd)).toBeCloseTo(0.1, 6); // 2 minutes at $0.05
    expect(Number(cost!.telephonyUsd)).toBeCloseTo(2 * CALL_RATES.phonePerMinute, 6);
    expect(Number(cost!.textsUsd)).toBeCloseTo(CALL_RATES.textEach, 6);
    expect(Number(cost!.totalUsd)).toBeCloseTo(expected.totalUsd, 6);
    // closing again (a retried close) replaces the row, never adds one
    await calls.close(DEMO_CLINIC.id, id, { reason: 'caller_hangup', voiceSeconds: 121, outcome: 'booked', emergency: false, usage: { models } });
    const rows = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.callCosts).where(sql`call_id = ${id}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.voiceSeconds).toBe('121.00');
  });

  it('a browser test call has no phone line to pay for', async () => {
    const id = await calls.open(DEMO_CLINIC.id, 'rtc_test_web_1', null, 'web', 'user_x', null, { engine: 'gpt-realtime', voiceFlow: 'tools' });
    await calls.close(DEMO_CLINIC.id, id, { reason: 'session_closed', voiceSeconds: 60, outcome: 'info', emergency: false });
    const [cost] = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.callCosts).where(sql`call_id = ${id}`));
    expect(cost).toMatchObject({ engine: 'gpt-realtime', telephonyUsd: '0.000000', texts: 0 });
    expect(Number(cost!.voiceUsd)).toBeCloseTo(CALL_RATES.voicePerMinute['gpt-realtime'], 6);
  });

  it('another clinic cannot read a clinic\'s call costs', async () => {
    const rows = await withClinic(t.db, 'clinic_other', (tx) => tx.select().from(schema.callCosts));
    expect(rows).toEqual([]);
  });
});

describe('the rates table', () => {
  it('prices priority processing at twice the tokens, and names a model it has no price for', () => {
    const models = { 'gpt-6-luna': { input: 1_000_000, cached: 0, output: 0 }, 'mystery-model': { input: 5, cached: 0, output: 5 } };
    const normal = callCost({ engine: 'gpt-live', channel: 'web', voiceSeconds: 0, models, texts: 0 });
    const fast = callCost({ engine: 'gpt-live', channel: 'web', voiceSeconds: 0, models, texts: 0, fastTier: true });
    expect(normal.modelUsd).toBeCloseTo(0.1, 6);
    expect(fast.modelUsd).toBeCloseTo(0.2, 6);
    expect(normal.unpriced).toEqual(['mystery-model']);
  });
});
