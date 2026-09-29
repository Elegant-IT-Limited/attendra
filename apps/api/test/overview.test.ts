import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

// Tuesday 29 September 2026, 10:30 in Denver.
const NOW = zonedInstant('2026-09-29', '10:30', DEMO_CLINIC.timezone);
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
let viewer: string;
let admin: string;

const call = (at: string, outcome: string, seconds: number, extra = '') =>
  api.t.db.execute(sql.raw(`insert into calls (clinic_id, openai_session_id, started_at, outcome, voice_seconds${extra ? ', channel' : ''})
    values ('${DEMO_CLINIC.id}', 'live_ov_${Math.random().toString(36).slice(2)}', '${at}', '${outcome}', ${seconds}${extra ? `, '${extra}'` : ''})`));

beforeAll(async () => {
  api = await startApi({ demoMode: false, now: () => NOW });
  staff = await api.signIn('ana@maple.example', true);
  viewer = await api.signIn('vic@maple.example', true);
  admin = await api.signIn('olga@maple.example', true);
  // the helper's own call (a refill, 48 s) started at the real time; put it on Monday afternoon
  await api.t.db.execute(sql`update calls set started_at = ${zonedInstant('2026-09-28', '14:00', DEMO_CLINIC.timezone).toISOString()} where id = ${api.callId}`);
  await api.t.db.execute(sql`update tasks set created_at = ${zonedInstant('2026-09-28', '14:01', DEMO_CLINIC.timezone).toISOString()} where id = ${api.taskId}`);
  const tz = (d: string, t: string) => zonedInstant(d, t, DEMO_CLINIC.timezone).toISOString();
  await call(tz('2026-09-29', '09:00'), 'booked', 120);       // today, open
  await call(tz('2026-09-29', '06:30'), 'cancelled', 60);     // today, before opening
  await call(tz('2026-09-27', '11:00'), 'rescheduled', 90);   // Sunday: closed
  await call(tz('2026-09-26', '10:00'), 'transferred', 30);   // Saturday: closed
  await call(tz('2026-09-10', '10:00'), 'booked', 600);       // outside the week
  await call(tz('2026-09-29', '09:30'), 'booked', 300, 'web'); // a browser test: not counted
});
afterAll(() => api.close());

describe('the overview', () => {
  it('counts today and the last seven days in the database, leaving out browser tests', async () => {
    const res = (await api.request('GET', `${C}/overview?days=7`, { cookie: staff })).json();
    expect(res.today).toEqual({ callsAnswered: 2, booked: 1, rescheduled: 0, cancelled: 1, requestsTaken: 0, handedToStaff: 0, afterHours: 1, talkMinutes: 3, estimatedCost: 0.15 });
    expect(res.period).toEqual({ callsAnswered: 5, booked: 1, rescheduled: 1, cancelled: 1, requestsTaken: 1, handedToStaff: 1, afterHours: 3, talkMinutes: 5.8, estimatedCost: 0.29 });
    expect(res).toMatchObject({ days: 7, costPerMinute: 0.05 });
  });

  it('carries no patient data, so a viewer sees it and nothing is audited', async () => {
    const before = (await api.t.db.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number };
    const res = await api.request('GET', `${C}/overview`, { cookie: viewer });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/Maria|Delgado|lisinopril/);
    const after = (await api.t.db.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('answers 404 for another clinic and validates the range', async () => {
    expect((await api.request('GET', `/api/v1/clinics/${OTHER.id}/overview`, { cookie: admin })).statusCode).toBe(404);
    expect((await api.request('GET', `${C}/overview?days=90`, { cookie: staff })).json().error).toBe('invalid_request');
  });
});

describe('waiting requests', () => {
  it('lists open unclaimed requests oldest first, with type and age only, not audited', async () => {
    const before = (await api.t.db.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number };
    const res = await api.request('GET', `${C}/tasks/waiting`, { cookie: staff });
    expect(res.json().tasks).toEqual([{ id: api.taskId, type: 'refill', createdAt: expect.any(String), callId: api.callId }]);
    expect(res.body).not.toMatch(/Maria|lisinopril|555/);
    const after = (await api.t.db.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('drops a request once someone claims it; a viewer cannot see the list; another clinic is 404', async () => {
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/claim`, { cookie: staff })).statusCode).toBe(204);
    expect((await api.request('GET', `${C}/tasks/waiting`, { cookie: staff })).json().tasks).toEqual([]);
    expect((await api.request('GET', `${C}/tasks/waiting`, { cookie: viewer })).statusCode).toBe(403);
    expect((await api.request('GET', `/api/v1/clinics/${OTHER.id}/tasks/waiting`, { cookie: admin })).statusCode).toBe(404);
  });
});
