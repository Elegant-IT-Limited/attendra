import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { saveClinic } from '@attendra/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

// Monday 28 September 2026, 8 pm in Denver; Tuesday the 29th is a working day.
const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);
const at = (date: string, time: string) => zonedInstant(date, time, DEMO_CLINIC.timezone).toISOString();
const C = `/api/v1/clinics/${DEMO_CLINIC.id}/appointments`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'admin' | 'staff' | 'viewer', string>;
let booked: string;

const audit = async (action: string) =>
  ((await api.t.db.execute(sql`select actor, entity_id from audit_logs where action = ${action} order by id`)).rows as { actor: string; entity_id: string }[]);
const bookBody = (time: string, key: string, extra: Record<string, unknown> = {}) =>
  ({ patientId: api.patientIds.james!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: at('2026-09-29', time), idempotencyKey: `test-key-${key}`, ...extra });

beforeAll(async () => {
  api = await startApi({ demoMode: false, now: () => NOW });
  // the demo's holidays follow the current year; this clock is fixed in 2026, so its holiday is too
  const clinic: typeof DEMO_CLINIC = { ...DEMO_CLINIC, holidays: ['2026-11-26'] };
  await saveClinic(api.t.db, 'org_demo', clinic);
  as = {
    owner: await api.signIn('omar@maple.example', true),
    admin: await api.signIn('olga@maple.example', true),
    staff: await api.signIn('ana@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true),
  };
  const res = await api.request('POST', C, { cookie: as.staff, body: bookBody('09:00', 'setup-booking-1', { note: 'Uses a walker.' }) });
  booked = res.json().appointmentId;
  if (!booked) throw new Error(`setup booking failed: ${res.body}`);
});
afterAll(() => api.close());

describe('who can use the schedule', () => {
  it('owners, managers and front desk read it; a viewer never does', async () => {
    for (const role of ['owner', 'admin', 'staff'] as const) {
      expect((await api.request('GET', `${C}?from=2026-09-29`, { cookie: as[role] })).statusCode, role).toBe(200);
      expect((await api.request('GET', `${C}/${booked}`, { cookie: as[role] })).statusCode, role).toBe(200);
      expect((await api.request('GET', `${C}/slots?visitTypeId=vt_sick&from=2026-09-29&days=1`, { cookie: as[role] })).statusCode, role).toBe(200);
    }
    for (const path of ['?from=2026-09-29', `/${booked}`, '/slots?visitTypeId=vt_sick']) {
      expect((await api.request('GET', `${C}${path}`, { cookie: as.viewer })).statusCode, path).toBe(403);
    }
  });

  it('a viewer cannot book, move or cancel', async () => {
    expect((await api.request('POST', C, { cookie: as.viewer, body: bookBody('11:00', 'viewer-1') })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/${booked}/reschedule`, { cookie: as.viewer, body: { startsAt: at('2026-09-29', '11:00') } })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/${booked}/cancel`, { cookie: as.viewer, body: {} })).statusCode).toBe(403);
  });

  it('another clinic answers 404 for every route, reads and writes', async () => {
    const O = `/api/v1/clinics/${OTHER.id}/appointments`;
    for (const path of ['?from=2026-09-29', `/${booked}`, '/slots?visitTypeId=vt_sick']) {
      expect((await api.request('GET', `${O}${path}`, { cookie: as.owner })).statusCode, path).toBe(404);
    }
    expect((await api.request('POST', O, { cookie: as.owner, body: bookBody('11:00', 'other-1') })).statusCode).toBe(404);
    expect((await api.request('POST', `${O}/${booked}/cancel`, { cookie: as.owner, body: {} })).statusCode).toBe(404);
  });

  it('refuses writes from another origin, even with a valid session', async () => {
    expect((await api.request('POST', C, { cookie: as.staff, body: bookBody('11:00', 'evil-1'), origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/${booked}/reschedule`, { cookie: as.staff, body: { startsAt: at('2026-09-29', '11:00') }, origin: null })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/${booked}/cancel`, { cookie: as.staff, body: {}, origin: 'https://evil.example' })).statusCode).toBe(403);
  });
});

describe('reading', () => {
  it('lists a day in clinic time with names and who booked, audited once for the range', async () => {
    const res = (await api.request('GET', `${C}?from=2026-09-29&days=1`, { cookie: as.admin })).json();
    expect(res.appointments).toEqual([expect.objectContaining({
      id: booked, patientName: 'James Whitaker', providerId: 'prov_okafor', status: 'booked', bookedBy: { kind: 'staff', name: 'Ana Front' },
    })]);
    // the admin opened this day in the role test too, a moment ago: still one row
    const mine = (await audit('schedule.viewed')).filter((r) => r.actor === `user:${api.users.admin}` && r.entity_id.startsWith('2026-09-29+1;provider=all;p:'));
    expect(mine).toHaveLength(1);
    expect((await api.request('GET', `${C}?from=2026-09-30&days=1`, { cookie: as.admin })).json().appointments).toEqual([]);
  });

  it('filters by provider', async () => {
    expect((await api.request('GET', `${C}?from=2026-09-29&providerId=prov_lindqvist`, { cookie: as.staff })).json().appointments).toEqual([]);
  });

  it('opens one appointment with the patient\'s details and the note, audited', async () => {
    const res = (await api.request('GET', `${C}/${booked}`, { cookie: as.staff })).json();
    expect(res).toMatchObject({ note: 'Uses a walker.', patient: { name: 'James Whitaker', dob: '1962-09-09', phone: '+13035550163' } });
    expect((await audit('appointment.viewed')).at(-1)).toEqual({ actor: `user:${api.users.staff}`, entity_id: booked });
    expect((await api.request('GET', `${C}/00000000-0000-4000-8000-000000000000`, { cookie: as.staff })).statusCode).toBe(404);
    expect((await api.request('GET', `${C}/not-a-uuid`, { cookie: as.staff })).statusCode).toBe(404);
  });

  it('offers open slots with no patient data and without the booked time, and writes no audit row', async () => {
    const before = (await api.t.db.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number };
    const res = await api.request('GET', `${C}/slots?visitTypeId=vt_sick&providerId=prov_okafor&from=2026-09-29&days=1`, { cookie: as.staff });
    const starts = res.json().slots.map((s: { startsAt: string }) => s.startsAt);
    expect(starts[0]).toBe(at('2026-09-29', '08:00'));
    expect(starts).not.toContain(at('2026-09-29', '09:00'));
    expect(res.body).not.toContain('James');
    const after = (await api.t.db.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
    const moving = await api.request('GET', `${C}/slots?visitTypeId=vt_sick&providerId=prov_okafor&from=2026-09-29&days=1&excluding=${booked}`, { cookie: as.staff });
    expect(moving.json().slots.map((s: { startsAt: string }) => s.startsAt)).toContain(at('2026-09-29', '09:00'));
  });

  it('validates the query', async () => {
    for (const q of ['', '?from=tomorrow', '?from=2026-09-29&days=30', '?from=2026-09-29&days=0']) {
      expect((await api.request('GET', `${C}${q}`, { cookie: as.staff })).json().error, q).toBe('invalid_request');
    }
    expect((await api.request('GET', `${C}/slots`, { cookie: as.staff })).json().error).toBe('invalid_request');
    expect((await api.request('GET', `${C}/slots?visitTypeId=vt_nothing`, { cookie: as.staff })).statusCode).toBe(422);
  });
});

describe('booking', () => {
  it('books, and the same key again is the same booking', async () => {
    const first = await api.request('POST', C, { cookie: as.staff, body: bookBody('10:00', 'book-1') });
    expect(first.json()).toEqual({ appointmentId: expect.any(String), status: 'done' });
    const again = await api.request('POST', C, { cookie: as.staff, body: bookBody('10:00', 'book-1') });
    expect(again.json()).toEqual({ appointmentId: first.json().appointmentId, status: 'already_done' });
    expect((await audit('appointment.booked.staff')).filter((r) => r.entity_id === first.json().appointmentId)).toEqual([{ actor: `user:${api.users.staff}`, entity_id: first.json().appointmentId }]);
  });

  it('answers 409 with a plain reason when the time cannot be booked', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [bookBody('09:00', 'c-taken'), 'taken'],
      [bookBody('07:40', 'c-closed'), 'closed'],
      [bookBody('09:00', 'c-past', { startsAt: at('2026-09-28', '15:00') }), 'past'],
      [bookBody('09:00', 'c-holiday', { startsAt: at('2026-11-26', '09:00') }), 'holiday'],
      [bookBody('09:00', 'c-offered', { providerId: 'prov_lindqvist', visitTypeId: 'vt_new' }), 'not_offered'],
    ];
    for (const [body, reason] of cases) {
      const res = await api.request('POST', C, { cookie: as.staff, body });
      expect(res.statusCode, reason).toBe(409);
      expect(res.json(), reason).toMatchObject({ error: 'slot_unavailable', reason, message: expect.any(String) });
    }
  });

  it('validates the body', async () => {
    const noKey: Record<string, unknown> = bookBody('11:00', 'x');
    delete noKey.idempotencyKey;
    for (const body of [noKey, bookBody('11:00', 'v-1', { patientId: 'maria' }), bookBody('11:00', 'v-2', { startsAt: 'tomorrow at 9' }), bookBody('11:00', 'v-3', { note: 'x'.repeat(501) })]) {
      expect((await api.request('POST', C, { cookie: as.staff, body })).json().error).toBe('invalid_request');
    }
    expect((await api.request('POST', C, { cookie: as.staff, body: bookBody('11:00', 'v-4', { providerId: 'prov_nobody' }) })).statusCode).toBe(422);
    expect((await api.request('POST', C, { cookie: as.staff, body: bookBody('11:00', 'v-5', { patientId: '00000000-0000-4000-8000-000000000000' }) })).statusCode).toBe(404);
  });
});

describe('moving and cancelling', () => {
  let id: string;
  beforeAll(async () => {
    id = (await api.request('POST', C, { cookie: as.admin, body: bookBody('14:00', 'move-1') })).json().appointmentId;
  });

  it('refuses a move into a taken slot and a time outside hours', async () => {
    expect((await api.request('POST', `${C}/${id}/reschedule`, { cookie: as.staff, body: { startsAt: at('2026-09-29', '09:00') } })).json()).toMatchObject({ reason: 'taken' });
    expect((await api.request('POST', `${C}/${id}/reschedule`, { cookie: as.staff, body: { startsAt: at('2026-09-29', '18:00') } })).json()).toMatchObject({ reason: 'closed' });
  });

  it('moves, audited, and a repeat changes nothing', async () => {
    const body = { startsAt: at('2026-09-29', '15:00'), providerId: 'prov_okafor' };
    expect((await api.request('POST', `${C}/${id}/reschedule`, { cookie: as.staff, body })).json()).toEqual({ appointmentId: id, status: 'done' });
    expect((await api.request('POST', `${C}/${id}/reschedule`, { cookie: as.staff, body })).json()).toEqual({ appointmentId: id, status: 'already_done' });
    expect(await audit('appointment.rescheduled.staff')).toEqual([{ actor: `user:${api.users.staff}`, entity_id: id }]);
  });

  it('cancels with a reason, audited, once', async () => {
    expect((await api.request('POST', `${C}/${id}/cancel`, { cookie: as.owner, body: { reason: 'patient_asked' } })).json()).toEqual({ appointmentId: id, status: 'done' });
    expect((await api.request('POST', `${C}/${id}/cancel`, { cookie: as.owner, body: {} })).json()).toEqual({ appointmentId: id, status: 'already_done' });
    expect(await audit('appointment.cancelled.staff')).toEqual([{ actor: `user:${api.users.owner}`, entity_id: id }]);
    const shown = (await api.request('GET', `${C}/${id}`, { cookie: as.staff })).json();
    expect(shown).toMatchObject({ status: 'cancelled', cancelReason: 'patient_asked', cancelledBy: { kind: 'staff', name: 'Omar Owner' } });
    expect((await api.request('POST', `${C}/${id}/reschedule`, { cookie: as.staff, body: { startsAt: at('2026-09-29', '16:00') } })).json()).toMatchObject({ reason: 'cancelled' });
  });

  it('shows only what is booked, only what was cancelled, or both, and the cancelled ones as a history', async () => {
    const day = async (status: string) => (await api.request('GET', `${C}?from=2026-09-29&days=1&status=${status}`, { cookie: as.staff })).json().appointments.map((a: { id: string; status: string }) => a.status);
    expect(await day('cancelled')).toEqual(['cancelled']);
    expect((await day('booked')).every((s: string) => s === 'booked')).toBe(true);
    expect((await day('all')).length).toBe((await day('booked')).length + 1);
    const history = async (body: object, cookie = as.staff) => api.request('POST', `${C}/cancelled`, { cookie, body: { from: '2026-09-01', to: '2026-10-31', ...body } });
    expect((await history({})).json().appointments).toEqual([expect.objectContaining({ id, status: 'cancelled', cancelReason: 'patient_asked', cancelledAt: expect.any(String) })]);
    expect((await history({ q: 'nobody' })).json().appointments).toEqual([]);
    expect((await history({ from: '2026-10-31', to: '2026-09-01' })).statusCode).toBe(422);
    expect((await history({}, as.viewer)).statusCode).toBe(403);
  });

  it('validates the reason and the time', async () => {
    expect((await api.request('POST', `${C}/${booked}/cancel`, { cookie: as.staff, body: { reason: 'because I said so' } })).json().error).toBe('invalid_request');
    expect((await api.request('POST', `${C}/${booked}/reschedule`, { cookie: as.staff, body: {} })).json().error).toBe('invalid_request');
    expect((await api.request('POST', `${C}/not-a-uuid/cancel`, { cookie: as.staff, body: {} })).statusCode).toBe(404);
  });
});

describe('mistakes the desk can make', () => {
  it('says plainly when the patient is already booked then, and when a key was used for something else', async () => {
    const busy = await api.request('POST', C, { cookie: as.staff, body: bookBody('09:00', 'patient-busy', { providerId: 'prov_lindqvist' }) });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ reason: 'patient_busy', message: 'James Whitaker already has an appointment then.' });
    const first = await api.request('POST', C, { cookie: as.staff, body: bookBody('11:40', 'key-once') });
    expect(first.json().status).toBe('done');
    const reuse = await api.request('POST', C, { cookie: as.staff, body: bookBody('12:40', 'key-once') });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error).toBe('idempotency_mismatch');
  });
});

describe('the daylight saving change on 2026-11-01', () => {
  it('lists the days across the change and books Monday 8:00 local, which is 15:00 UTC', async () => {
    const monday = zonedInstant('2026-11-02', '08:00', DEMO_CLINIC.timezone).toISOString();
    expect(monday).toBe('2026-11-02T15:00:00.000Z');
    const res = await api.request('POST', C, { cookie: as.staff, body: bookBody('08:00', 'dst-monday', { startsAt: monday }) });
    expect(res.json().status).toBe('done');
    const friday = await api.request('POST', C, { cookie: as.staff, body: bookBody('09:00', 'dst-friday', { startsAt: zonedInstant('2026-10-30', '09:00', DEMO_CLINIC.timezone).toISOString() }) });
    expect(friday.json().status).toBe('done');
    // Sunday the 1st is 25 hours long: the range from it takes in Monday, and not the Friday before
    const range = (await api.request('GET', `${C}?from=2026-11-01&days=2`, { cookie: as.staff })).json().appointments;
    expect(range.map((a: { id: string; startsAt: string }) => a.startsAt)).toEqual([monday]);
    expect((await api.request('GET', `${C}?from=2026-10-31&days=1`, { cookie: as.staff })).json().appointments).toEqual([]);
    expect((await api.request('POST', C, { cookie: as.staff, body: bookBody('10:00', 'dst-sunday', { startsAt: zonedInstant('2026-11-01', '10:00', DEMO_CLINIC.timezone).toISOString() }) })).json().reason).toBe('closed');
  });
});

describe('a call and what it booked', () => {
  it('shows the appointments a call booked on the call page', async () => {
    const call = (await api.request('GET', `/api/v1/clinics/${DEMO_CLINIC.id}/calls/${api.callId}`, { cookie: as.staff })).json();
    expect(call.appointments).toEqual([]);
  });
});
