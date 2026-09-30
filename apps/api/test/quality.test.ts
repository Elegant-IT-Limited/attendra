import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const tz = DEMO_CLINIC.timezone;
// Wednesday 30 September 2026, noon in Denver: this week runs Monday 28 September to Sunday 4 October
const NOW = zonedInstant('2026-09-30', '12:00', tz);
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'admin' | 'staff' | 'viewer', string>;

async function call(at: Date, outcome: string, o: { seconds?: number; tools?: [string, Record<string, unknown>][]; turns?: number; flagged?: boolean; channel?: string; close?: string } = {}) {
  const [row] = (await api.t.db.execute(sql`insert into calls (clinic_id, openai_session_id, started_at, ended_at, outcome, voice_seconds, channel, close_reason)
    values (${DEMO_CLINIC.id}, ${`live_q_${Math.random()}`}, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz, ${outcome}, ${o.seconds ?? 60}, ${o.channel ?? 'phone'}, ${o.close ?? 'caller_hangup'}) returning id`)).rows as { id: string }[];
  const id = row!.id;
  for (const [tool, result] of o.tools ?? []) {
    await api.t.db.execute(sql`insert into call_actions (clinic_id, call_id, tool, args_redacted, result, task_revision) values (${DEMO_CLINIC.id}, ${id}, ${tool}, '[]'::jsonb, ${JSON.stringify(result)}::jsonb, 1)`);
  }
  for (let i = 0; i < (o.turns ?? 0); i++) {
    await api.t.db.execute(sql`insert into call_segments (clinic_id, call_id, speaker, text_enc, start_ms, end_ms) values (${DEMO_CLINIC.id}, ${id}, 'caller', 'x', ${i * 1000}, ${i * 1000 + 500})`);
  }
  if (o.flagged) await api.t.db.execute(sql`insert into call_summaries (call_id, clinic_id, body_enc, intent, sentiment, needs_review, model) values (${id}, ${DEMO_CLINIC.id}, 'x', 'other', 'calm', true, 'local')`);
  return id;
}

beforeAll(async () => {
  api = await startApi({ demoMode: false, now: () => NOW });
  as = { admin: await api.signIn('olga@maple.example', true), staff: await api.signIn('ana@maple.example', true), viewer: await api.signIn('vic@maple.example', true) };
  // the helper's own call is in some other week; start from a clean slate
  await api.t.db.execute(sql`update calls set started_at = '2026-01-05T15:00:00Z'`);
  const monday9 = zonedInstant('2026-09-28', '09:00', tz);
  await call(monday9, 'booked', { seconds: 120, turns: 4, tools: [['propose_booking', { ok: true }], ['commit_pending', { ok: true, booked: true }]] });
  await call(monday9, 'booked', { seconds: 180, turns: 6, tools: [['propose_booking', { ok: true }], ['commit_pending', { ok: false, error: 'no_clear_yes' }], ['commit_pending', { ok: true, booked: true }]] });
  await call(monday9, 'abandoned', { seconds: 60, turns: 3, tools: [['propose_booking', { ok: true }], ['commit_pending', { ok: false, error: 'no_clear_yes' }]], flagged: true });
  await call(monday9, 'info', { seconds: 30, turns: 1 });
  await call(zonedInstant('2026-09-28', '21:00', tz), 'transferred', { seconds: 90, close: 'transferred', tools: [['verify_caller', { ok: false, error: 'not_verified' }]] });
  await call(monday9, 'booked', { channel: 'web' }); // a browser test: not counted
  await call(zonedInstant('2026-09-22', '10:00', tz), 'task_created', { seconds: 60 }); // last week
});
afterAll(() => api.close());

describe('the quality page', () => {
  it('counts this week: containment, bookings, turns, refusals, handovers, reviews, after hours and cost', async () => {
    const res = await api.request('GET', `${C}/quality?weeks=2`, { cookie: as.admin });
    expect(res.statusCode).toBe(200);
    const [week, last] = res.json().weeks;
    expect(week).toMatchObject({
      start: '2026-09-28', end: '2026-10-04', calls: 5, contained: 3, containmentRate: 0.6,
      bookingAttempts: 3, bookings: 2, bookingSuccess: 0.667, avgTurnsToBooking: 5,
      refusals: [{ code: 'no_clear_yes', count: 2 }, { code: 'not_verified', count: 1 }],
      transferred: 1, transferredShare: 0.2, flagged: 1, flaggedShare: 0.2, afterHours: 1,
      voiceMinutes: 8, cost: 0.4, costPerCall: 0.08, costPerBooking: 0.2,
    });
    expect(last).toMatchObject({ start: '2026-09-21', calls: 1, contained: 0, containmentRate: 0, bookingSuccess: null, avgTurnsToBooking: null });
    expect(res.body).not.toMatch(/Maria|Delgado|lisinopril/);
  });

  it('is for owners and managers', async () => {
    expect((await api.request('GET', `${C}/quality`, { cookie: as.staff })).statusCode).toBe(403);
    expect((await api.request('GET', `${C}/quality`, { cookie: as.viewer })).statusCode).toBe(403);
  });

  it('links to the calls behind a refusal', async () => {
    const res = await api.request('GET', `${C}/calls?refusal=no_clear_yes&from=2026-09-28&to=2026-10-04`, { cookie: as.admin });
    expect(res.json().calls).toHaveLength(2);
    expect((await api.request('GET', `${C}/calls?refusal=NOT-A-CODE`, { cookie: as.admin })).statusCode).toBe(422);
  });
});
