import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { saveClinic } from '@attendra/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// Monday 28 September 2026, 8 pm in Denver. Dr. Okafor has the clinic's hours (Tuesday 8-12, 1-5); Dr. Lindqvist her own
// (Tuesday and Thursday 9-3).
const tz = DEMO_CLINIC.timezone;
const NOW = zonedInstant('2026-09-28', '20:00', tz);
const at = (date: string, time: string) => zonedInstant(date, time, tz).toISOString();
const S = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let cookie: string;

const audit = async (action: string) => ((await api.t.owner.execute(sql`select entity_id from audit_logs where action = ${action} order by id`)).rows as { entity_id: string }[]).map((r) => r.entity_id);
const conflicts = async () => (await api.request('GET', `${S}/appointments/conflicts`, { cookie })).json().conflicts;
async function book(patient: 'maria' | 'james', providerId: string, date: string, time: string, key: string, extra: Record<string, unknown> = {}) {
  const res = await api.request('POST', `${S}/appointments`, { cookie, body: { patientId: api.patientIds[patient], providerId, visitTypeId: 'vt_sick', startsAt: at(date, time), idempotencyKey: key, ...extra } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().appointmentId as string;
}

beforeAll(async () => {
  api = await startApi({ demoMode: false, now: () => NOW });
  // the demo's holidays follow the current year; this clock is fixed in 2026, so its holiday is too
  const clinic: typeof DEMO_CLINIC = { ...DEMO_CLINIC, holidays: ['2026-11-26'] };
  await saveClinic(api.t.db, 'org_demo', clinic);
  cookie = await api.signIn('omar@maple.example', true);
});
afterAll(() => api.close());

describe('a change of hours that strands booked visits is never silent (SCH-4)', () => {
  it('cutting the clinic\'s hours answers with the "move or keep" list and saves nothing; kept, it saves, leaves the visit as it was, audited, and the Schedule warns', async () => {
    const late = await book('maria', 'prov_okafor', '2026-10-06', '16:20', 'stranded-late');
    await book('james', 'prov_okafor', '2026-10-06', '09:00', 'stranded-fine');
    expect(await conflicts()).toEqual([]);
    const settings = (await api.request('GET', `${S}/settings`, { cookie })).json();
    const shorter = { ...settings, hours: { ...settings.hours, 2: [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '16:00' }] } };

    const asked = await api.request('PUT', `${S}/settings`, { cookie, body: shorter });
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toEqual({
      error: 'strands_visits',
      message: '1 booked visit would be outside the hours. Move it first, or save again with keepStranded=true to keep it where it is.',
      visits: [{ appointmentId: late, startsAt: at('2026-10-06', '16:20'), endsAt: at('2026-10-06', '16:40'), providerId: 'prov_okafor', visitTypeId: 'vt_sick', patientName: 'Maria Delgado', reason: 'outside_hours' }],
    });
    // the names were shown, so it is a view of that patient; nothing was saved
    expect((await audit('schedule.viewed')).some((e) => e.startsWith('stranded;'))).toBe(true);
    expect((await api.request('GET', `${S}/settings`, { cookie })).json().hours['2']).toEqual(settings.hours['2']);
    expect(await audit('appointment.kept_outside_hours')).toEqual([]);

    const kept = await api.request('PUT', `${S}/settings?keepStranded=true`, { cookie, body: shorter });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().hours['2']).toEqual(shorter.hours[2]);
    expect(await audit('appointment.kept_outside_hours')).toEqual([late]);
    const visit = (await api.request('GET', `${S}/appointments/${late}`, { cookie })).json();
    expect(visit).toMatchObject({ status: 'booked', startsAt: at('2026-10-06', '16:20'), overrideReason: null });
    expect(await conflicts()).toEqual([{ date: '2026-10-06', providerId: 'prov_okafor', reason: 'outside_hours', count: 1 }]);

    // a later save that strands nothing new goes straight through
    const current = (await api.request('GET', `${S}/settings`, { cookie })).json();
    expect((await api.request('PUT', `${S}/settings`, { cookie, body: { ...current, assistantName: 'Maya' } })).statusCode).toBe(200);
  });

  it('a vet\'s own hours cut, or a day off, asks the same on the Doctors page; kept, it saves', async () => {
    const visit = await book('james', 'prov_lindqvist', '2026-10-13', '14:00', 'stranded-vet');
    const settings = (await api.request('GET', `${S}/settings`, { cookie })).json();
    const lindqvist = { ...settings.providers.find((p: { id: string }) => p.id === 'prov_lindqvist') };
    delete lindqvist.id;
    const cut = { ...lindqvist, hours: { 2: [{ open: '09:00', close: '12:00' }], 4: [{ open: '09:00', close: '15:00' }] } };
    const asked = await api.request('PUT', `${S}/doctors/prov_lindqvist`, { cookie, body: cut });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().visits).toEqual([expect.objectContaining({ appointmentId: visit, providerId: 'prov_lindqvist', patientName: 'James Whitaker', reason: 'outside_hours' })]);
    // a day off over it says so
    const away = await api.request('PUT', `${S}/doctors/prov_lindqvist`, { cookie, body: { ...lindqvist, timeOff: [{ from: '2026-10-13', to: '2026-10-13' }] } });
    expect(away.json().visits).toEqual([expect.objectContaining({ appointmentId: visit, reason: 'away' })]);
    // the hours untouched while it is asked
    expect((await api.request('GET', `${S}/doctors`, { cookie })).json().providers.find((p: { id: string }) => p.id === 'prov_lindqvist').hours['2']).toEqual([{ open: '09:00', close: '15:00' }]);
    const kept = await api.request('PUT', `${S}/doctors/prov_lindqvist?keepStranded=true`, { cookie, body: cut });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(await audit('appointment.kept_outside_hours')).toContain(visit);
    // a change that keeps every visit inside goes straight through
    expect((await api.request('PUT', `${S}/doctors/prov_lindqvist`, { cookie, body: { ...cut, hours: { ...cut.hours, 4: [{ open: '09:00', close: '16:00' }] } } })).statusCode).toBe(200);
  });

  it('a holiday or a special day over a booked visit asks too', async () => {
    const visit = await book('maria', 'prov_okafor', '2026-10-20', '10:00', 'stranded-holiday');
    const settings = (await api.request('GET', `${S}/settings`, { cookie })).json();
    const holiday = await api.request('PUT', `${S}/settings`, { cookie, body: { ...settings, holidays: [...settings.holidays, '2026-10-20'] } });
    expect(holiday.json().visits).toEqual([expect.objectContaining({ appointmentId: visit, reason: 'holiday' })]);
    const half = await api.request('PUT', `${S}/settings`, { cookie, body: { ...settings, specialDays: [{ date: '2026-10-20', windows: [{ open: '08:00', close: '09:30' }] }] } });
    expect(half.json().visits).toEqual([expect.objectContaining({ appointmentId: visit, reason: 'holiday' })]);
    // a special day that lists the vet keeps their hours: nothing to ask
    expect((await api.request('PUT', `${S}/settings`, { cookie, body: { ...settings, specialDays: [{ date: '2026-10-20', windows: [], providerIds: ['prov_okafor'] }] } })).statusCode).toBe(200);
  });

  it('a visit squeezed in outside the hours with Override is not warned about as outside the hours', async () => {
    await book('maria', 'prov_okafor', '2026-10-21', '17:30', 'stranded-override', { override: true, overrideReason: 'Walk-in after hours' });
    expect((await conflicts()).filter((c: { date: string }) => c.date === '2026-10-21')).toEqual([]);
  });
});
