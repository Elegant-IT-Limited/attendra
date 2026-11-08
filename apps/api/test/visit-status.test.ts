import { DEMO_CLINIC, DESK_STATUS_REFUSED, zonedInstant } from '@attendra/core';
import { saveClinic } from '@attendra/db';
import type { WebhookEventJob } from '@attendra/worker/queue';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { EVENT_TYPES } from '@attendra/webhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEBHOOK_EVENTS } from '../src/contracts';
import { OTHER, startApi } from './helpers';

const tz = DEMO_CLINIC.timezone;
const at = (date: string, time: string) => zonedInstant(date, time, tz);
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let now = at('2026-09-28', '20:00');
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'admin' | 'staff' | 'viewer', string>;
const events: WebhookEventJob[] = [];

const book = async (time: string, key: string, patient: 'james' | 'maria' = 'james') => {
  const res = await api.request('POST', `${C}/appointments`, { cookie: as.staff, body: { patientId: api.patientIds[patient], providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: at('2026-09-29', time).toISOString(), idempotencyKey: `status-${key}` } });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().appointmentId as string;
};
const mark = (id: string, status: string, cookie = as.staff) => api.request('POST', `${C}/appointments/${id}/status`, { cookie, body: { status } });

beforeAll(async () => {
  api = await startApi({
    demoMode: false, now: () => now,
    jobs: { callCompleted: async () => {}, indexDocument: async () => {}, webhookEvent: async (e) => { events.push(e); }, requestReady: async () => {}, smsStatus: async () => {} },
  });
  await saveClinic(api.t.db, 'org_demo', { ...DEMO_CLINIC, holidays: [] });
  as = { admin: await api.signIn('olga@maple.example', true), staff: await api.signIn('ana@maple.example', true), viewer: await api.signIn('vic@maple.example', true) };
  await api.t.owner.execute(sql`update clinics set created_at = '2026-06-01T15:00:00Z' where id = ${DEMO_CLINIC.id}`);
});
afterAll(() => api.close());

describe('the desk marks visits', () => {
  it('arrived, then completed: audited, shown with who and when, one webhook event each, and never twice', async () => {
    const id = await book('09:00', 'a');
    const early = await mark(id, 'arrived');
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'status_refused', reason: 'too_early', message: DESK_STATUS_REFUSED.too_early });
    now = at('2026-09-29', '08:50');
    expect((await mark(id, 'arrived')).json()).toEqual({ appointmentId: id, status: 'done' });
    expect((await mark(id, 'arrived')).json()).toEqual({ appointmentId: id, status: 'already_done' });
    now = at('2026-09-29', '09:20');
    expect((await mark(id, 'completed')).json()).toEqual({ appointmentId: id, status: 'done' });
    const day = (await api.request('GET', `${C}/appointments?from=2026-09-29&days=1`, { cookie: as.staff })).json();
    expect(day.appointments.find((a: { id: string }) => a.id === id)).toMatchObject({ status: 'completed', statusChangedBy: 'Ana Front', statusChangedAt: now.toISOString() });
    // the "booked" filter is what is on the calendar, whatever the desk marked it
    const onCalendar = (await api.request('GET', `${C}/appointments?from=2026-09-29&days=1&status=booked`, { cookie: as.staff })).json();
    expect(onCalendar.appointments.map((a: { id: string }) => a.id)).toContain(id);
    const mine = events.filter((e) => e.type === 'appointment.status_changed' && e.data.appointmentId === id);
    expect(mine.map((e) => [e.data.previousStatus, e.data.status])).toEqual([['booked', 'arrived'], ['arrived', 'completed']]);
    expect(mine[0]!.data).toMatchObject({ by: 'staff', providerId: 'prov_okafor', startsAt: at('2026-09-29', '09:00').toISOString() });
    expect(JSON.stringify(mine)).not.toMatch(/James|Whitaker/);
    const rows = (await api.t.owner.execute(sql`select action from audit_logs where entity_id = ${id} and action like 'appointment.status.%' order by id`)).rows;
    expect(rows).toEqual([{ action: 'appointment.status.arrived' }, { action: 'appointment.status.completed' }]);
  });

  it('a no-show only once the visit has started, and back to booked undoes it', async () => {
    now = at('2026-09-28', '20:00');
    const id = await book('10:00', 'b');
    now = at('2026-09-29', '09:59');
    expect((await mark(id, 'no_show')).json()).toMatchObject({ reason: 'not_started', message: DESK_STATUS_REFUSED.not_started });
    now = at('2026-09-29', '10:15');
    expect((await mark(id, 'no_show')).statusCode).toBe(200);
    expect((await mark(id, 'booked')).statusCode).toBe(200);
    expect((await mark(id, 'no_show')).statusCode).toBe(200);
  });

  it('a viewer cannot mark a visit, a state that is not the desk\'s is refused, and another clinic answers 404', async () => {
    const id = (await api.t.owner.execute(sql`select id from appointments where clinic_id = ${DEMO_CLINIC.id} limit 1`)).rows[0] as { id: string };
    expect((await mark(id.id, 'arrived', as.viewer)).statusCode).toBe(403);
    expect((await mark(id.id, 'cancelled')).statusCode).toBe(422);
    expect((await api.request('POST', `/api/v1/clinics/${OTHER.id}/appointments/${id.id}/status`, { cookie: as.staff, body: { status: 'arrived' } })).statusCode).toBe(404);
  });
});

describe('Quality counts no-shows', () => {
  it('this week: the visits due that have started, those marked no-show, and their share', async () => {
    now = at('2026-09-30', '12:00');
    const q = (await api.request('GET', `${C}/quality?weeks=1`, { cookie: as.admin })).json();
    // two visits due this week by now (9:00 completed, 10:00 no-show) plus the helper's own, if any is in the week
    const due = ((await api.t.owner.execute(sql`select count(*)::int as n from appointments where clinic_id = ${DEMO_CLINIC.id} and status <> 'cancelled'
      and starts_at >= ${at('2026-09-28', '00:00')} and starts_at <= ${now}`)).rows[0] as { n: number }).n;
    expect(q.weeks[0]).toMatchObject({ visitsDue: due, noShows: 1, noShowShare: Math.round((1 / due) * 1000) / 1000 });
  });
});

describe('the webhook events, in one list', () => {
  it('the API, the delivery package and docs/webhooks.md name the same events', () => {
    expect([...WEBHOOK_EVENTS]).toEqual([...EVENT_TYPES]);
    const doc = readFileSync(new URL('../../../docs/webhooks.md', import.meta.url), 'utf8');
    const documented = [...doc.matchAll(/^\| `([a-z_.]+)` \|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual([...EVENT_TYPES].sort());
  });
});
