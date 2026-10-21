import { ClinicConfig, DEMO_CLINIC, RIVERBEND_CLINIC, zonedInstant } from '@attendra/core';
import { schema, withClinic } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ToolResult, whyNot } from '../src';
import { world } from './support';

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  w = await world();
  // Maria has seen Dr. Lindqvist twice this year
  for (const d of ['2026-03-10', '2026-06-16']) {
    await withClinic(w.t.db, DEMO_CLINIC.id, (tx) => tx.insert(schema.appointments).values({
      clinicId: DEMO_CLINIC.id, patientId: w.patientIds.maria!, providerId: 'prov_lindqvist', visitTypeId: 'vt_sick',
      startsAt: zonedInstant(d, '10:00', DEMO_CLINIC.timezone), endsAt: zonedInstant(d, '10:20', DEMO_CLINIC.timezone), idempotencyKey: `past-${d}`, createdByUserId: 'u_ana',
    }));
  }
});
afterAll(() => w.t.close());

const data = (r: ToolResult) => r.data as { slots: { provider: string; when: string }[]; note: string };
const search = async (clinic?: ClinicConfig) => {
  const c = await w.call('+13035550147', { clinic });
  c.caller('Maria Delgado, March 4th 1985. I need a sick visit, any doctor.');
  const out = await c.delegate([
    { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985' } },
    { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
  ]);
  return data(out.results[1]!);
};

describe('who the assistant books with when the caller names nobody', () => {
  it('offers the usual doctor first, and a sooner time with someone else last', async () => {
    const r = await search();
    expect(r.slots.slice(0, 3).every((s) => s.provider === 'Dr. Ann Lindqvist')).toBe(true);
    expect(r.slots[3]).toMatchObject({ provider: 'Dr. Nkem Okafor' }); // 8:00, before her 9:00
    expect(r.note).toContain('Dr. Ann Lindqvist, who usually sees Maria');
    expect(r.note).toContain('mention it only if none');
  });

  it('says so when the usual doctor has nothing soon enough, and offers the others', async () => {
    const away = ClinicConfig.parse({ ...DEMO_CLINIC, providers: DEMO_CLINIC.providers.map((p) => (p.id === 'prov_lindqvist' ? { ...p, timeOff: [{ from: '2026-09-28', to: '2026-10-02' }] } : p)) });
    const r = await search(away);
    expect(r.slots.length).toBeGreaterThan(0);
    expect(r.slots.every((s) => s.provider !== 'Dr. Ann Lindqvist')).toBe(true);
    expect(r.note).toContain('has nothing in the next 3 days');
  });

  it('offers the earliest times with anyone when the clinic chose that, three different times', async () => {
    const r = await search(ClinicConfig.parse({ ...DEMO_CLINIC, booking: { noPreference: 'earliest' } }));
    expect(r.note).not.toContain('usually');
    expect(new Set(r.slots.map((s) => s.when)).size).toBe(r.slots.length);
  });
});

describe('a time of day the caller names', () => {
  it('"after 3" offers nothing before 3, and "at 10:30" says when that exact time is taken', async () => {
    const c = await w.call('+17205550172', { clinic: { ...RIVERBEND_CLINIC, afterHours: 'book' } });
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit', phone: null } }]);
    const after = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-10-01', part_of_day: 'any', from_time: '15:00' } }]);
    const slots = after.results[0]!.data.slots as { when: string }[];
    expect(slots.length).toBe(3);
    expect(slots.every((s) => /Thursday, October 1 at (3|4|5):\d\d PM/.test(s.when))).toBe(true);
    expect(String(after.results[0]!.data.note)).not.toContain('exactly');
    // 10:35 is not on the 30-minute grid, so the nearest after it is offered and the result says so
    const odd = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-10-01', part_of_day: 'any', from_time: '10:35' } }]);
    expect(String(odd.results[0]!.data.note)).toContain('Nothing is free at exactly 10:35');
    expect((odd.results[0]!.data.slots as { when: string }[])[0]!.when).toContain('11:00 AM');
  });
});

describe('a pet and the vets who see its kind of animal', () => {
  it('refuses plainly when no vet is listed for the animal', async () => {
    const birdsOnly = ClinicConfig.parse({ ...RIVERBEND_CLINIC, afterHours: 'book', providers: RIVERBEND_CLINIC.providers.map((p) => ({ ...p, categories: ['Birds'] })) });
    const c = await w.call('+13035550147', { clinic: birdsOnly });
    // a found pet: a dog, at a clinic whose vets all see birds only
    c.state.verifiedPatient = { id: w.patientIds.maria!, firstName: 'Biscuit', phone: '+13035550147', dob: '2020-01-01', isNew: false, gender: null, species: 'dog' };
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: birdsOnly.visitTypes[0]!.id, provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(out.errors).toEqual(['no_provider_for_animal']);
    // named by the caller, a vet is still offered: the caller's choice wins
    const named = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: birdsOnly.visitTypes[0]!.id, provider_id: birdsOnly.providers[0]!.id, from_date: null, part_of_day: 'any' } }]);
    expect(named.errors).toEqual([null]);
  });
});

describe('why a day or a provider is not possible as asked', () => {
  const clinic = RIVERBEND_CLINIC;
  const now = zonedInstant('2026-09-28', '10:00', clinic.timezone);
  const today = '2026-09-28';
  const ruiz = { ...clinic.providers[0]!, timeOff: [{ from: '2026-09-28', to: '2026-10-04', note: 'vacation' }] };
  const sato = clinic.providers.find((p) => p.id === 'prov_sato')!; // Tuesdays and Thursdays

  it('says nothing when the day and the provider are fine', () => {
    expect(whyNot(clinic, { date: '2026-09-29', now, today })).toBeNull();
    expect(whyNot(clinic, { date: '2026-09-29', provider: sato, now, today })).toBeNull();
  });

  it('names a closed day, a half day, a vet away, and a vet\'s days', () => {
    const half = { ...clinic, specialDays: [{ date: '2026-09-30', windows: [{ open: '08:00', close: '12:00' }], note: 'staff training' }] };
    expect(whyNot(half, { date: '2026-09-30', now, today })).toContain('open 08:00 to 12:00 only (staff training)');
    const shut = { ...clinic, specialDays: [{ date: '2026-09-29', windows: [], note: 'staff day' }] };
    expect(whyNot(shut, { date: '2026-09-29', now, today })).toContain('closed on Tuesday 2026-09-29 (staff day)');
    expect(whyNot(clinic, { date: '2026-09-30', provider: ruiz, now, today })).toContain('away from 2026-09-28 to 2026-10-04 (vacation), back on 2026-10-05');
    expect(whyNot(clinic, { date: null, provider: ruiz, now, today })).toContain('away until 2026-10-04');
    expect(whyNot(clinic, { date: '2026-09-30', provider: sato, now, today })).toContain('not in on Wednesdays; their days are Tuesday, Thursday');
  });

  it('says how much notice a visit needs when the day asked for is too soon', () => {
    expect(whyNot(clinic, { date: '2026-09-29', noticeHours: 48, now, today })).toContain("needs 48 hours' notice, so the first day it can be booked for is 2026-09-30");
    expect(whyNot(clinic, { date: '2026-10-02', noticeHours: 48, now, today })).toBeNull();
  });
});
