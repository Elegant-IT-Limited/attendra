import { BOOKING_LEAD_MINUTES, ClinicConfig, DESK_LEAD_MINUTES, RIVERBEND_CLINIC, zonedInstant } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPrompt } from '../src';
import { world } from './support';

// Made-up vets (2026-11-15). The front desk is open Monday to Friday 8 to 6 and Saturday morning. Dr. Vance keeps her
// own hours (Sunday 9 to 1, Friday 9 to 1 and 2 to 6) and does sick visits and new patient exams only; Dr. Rahman is
// in until 7 on weekdays, and away 4:00 to 4:20 on Wednesday, September 30. The calls are on Monday, September 28.
const FRIDAY = [{ open: '09:00', close: '13:00' }, { open: '14:00', close: '18:00' }];
const LATE = [{ open: '08:00', close: '19:00' }];
const clinic = ClinicConfig.parse({
  ...RIVERBEND_CLINIC, afterHours: 'book',
  visitTypes: [...RIVERBEND_CLINIC.visitTypes, { id: 'vt_quick', name: 'quick check', names: { es: 'revisión rápida' }, minutes: 10 }],
  providers: [
    { id: 'prov_morgan', name: 'Dr. Mara Vance', gender: 'female', visitTypeIds: ['vt_sick', 'vt_new'], hours: { 0: [{ open: '09:00', close: '13:00' }], 5: FRIDAY } },
    { id: 'prov_rahman', name: 'Dr. Omar Rahman', gender: 'male', visitTypeIds: ['vt_wellness', 'vt_sick', 'vt_vaccines', 'vt_quick'],
      hours: { 1: LATE, 2: LATE, 3: LATE, 4: LATE, 5: LATE }, timeOff: [{ from: '2026-09-30', to: '2026-09-30', start: '16:00', end: '16:20', note: 'team meeting' }] },
    { id: 'prov_khan', name: 'Dr. Leila Khan', gender: 'female', visitTypeIds: ['vt_wellness', 'vt_sick', 'vt_vaccines', 'vt_quick'] },
  ],
});

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const find = async (args: Record<string, unknown>, opts: { language?: 'en' | 'es'; clinic?: ClinicConfig } = {}) => {
  const c = await w.call('+13035550190', { clinic: opts.clinic ?? clinic });
  if (opts.language) c.state.language = opts.language;
  const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any', from_time: null, ...args } }]);
  return out.results[0]!.data as { slots: { when: string; provider: string }[]; say_as?: string; reason?: string; exact?: { time: string; free: boolean }; error?: string };
};

describe('a vet\'s own hours (item 1)', () => {
  it('a Sunday with the vet who works it: offered, with the front-desk sentence first', async () => {
    const r = await find({ provider_id: 'prov_morgan', from_date: '2026-10-04' });
    expect(r.slots[0]!.when).toBe('Sunday, October 4, at 9:00 AM');
    expect(r.say_as).toBe('The clinic\'s front desk is closed on Sundays, but Dr. Mara Vance sees patients Sunday from 9 to 1. On Sunday, October 4, I have 9:00, 9:20 or 9:40 AM with Dr. Mara Vance.');
    expect(r.reason).toBeUndefined();
  });

  it('a caller who can\'t pick is offered the first time alone, for a yes (batch 1d: live runs asked them to choose again and again)', async () => {
    const r = await find({ provider_id: 'prov_morgan', from_date: '2026-10-04' }) as { note?: string };
    expect(r.note).toContain('If the caller can\'t choose');
    expect(r.note).toContain('offer the first time alone, Sunday, October 4, at 9:00 AM');
  });

  it('the same in Spanish', async () => {
    const r = await find({ provider_id: 'prov_morgan', from_date: '2026-10-04' }, { language: 'es' });
    expect(r.say_as).toMatch(/^La recepción de la clínica está cerrada los domingos, pero (?:la )?Dra\. Mara Vance atiende el domingo de 9 a 1\. /);
  });

  it('after the desk closes: "closes at 6, but Dr. Rahman sees patients until 7"', async () => {
    const r = await find({ provider_id: 'prov_rahman', from_date: '2026-09-29', from_time: '18:20', time_mode: 'at' });
    expect(r.exact).toEqual({ time: '18:20', free: true });
    expect(r.say_as).toBe('The clinic\'s front desk closes at 6 on Tuesdays, but Dr. Omar Rahman sees patients until 7. Yes, 6:20 PM on Tuesday, September 29 is free with Dr. Omar Rahman. Shall I book it?');
  });

  it('get_clinic_info gives the hours the search uses', async () => {
    const c = await w.call('+13035550190', { clinic });
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'when is Dr. Vance in' } }]);
    const vance = (out.results[0]!.data.providers as { name: string; hours: string }[]).find((p) => p.name === 'Dr. Mara Vance')!;
    expect(vance.hours).toBe('Fri 09:00-13:00, 14:00-18:00; Sun 09:00-13:00');
  });
});

describe('the lead time', () => {
  it('at 10:00 the assistant offers nothing before 12:00, while the desk keeps its own 5 minutes', async () => {
    const ten = zonedInstant('2026-09-29', '10:00', clinic.timezone);
    const c = await w.call('+13035550190', { clinic, now: ten });
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: 'prov_khan', from_date: '2026-09-29', part_of_day: 'any', from_time: null } }]);
    const slots = out.results[0]!.data.slots as { when: string }[];
    expect(slots[0]!.when).toBe('Tuesday, September 29, at 12:00 PM');
    expect([...c.state.offered.values()].every((s) => s.start.getTime() >= ten.getTime() + BOOKING_LEAD_MINUTES * 60_000)).toBe(true);
    expect([BOOKING_LEAD_MINUTES, DESK_LEAD_MINUTES]).toEqual([120, 5]);
  });
});

describe('the nearest times to the one asked for (item 3)', () => {
  it('The owner\'s example: "is Dr. Rahman available on September 30 at 4 PM?" with 4:00 taken', async () => {
    const r = await find({ visit_type_id: 'vt_quick', provider_id: 'prov_rahman', from_date: '2026-09-30', from_time: '16:00', time_mode: 'at' });
    expect(r.exact).toEqual({ time: '16:00', free: false });
    expect(r.say_as).toBe('Not at 4:00, but 3:50 or 4:20 PM on Wednesday, September 30.');
  });

  it('a free time: the direct yes first', async () => {
    const r = await find({ visit_type_id: 'vt_quick', provider_id: 'prov_rahman', from_date: '2026-09-30', from_time: '17:00', time_mode: 'around' });
    expect(r.say_as).toBe('Yes, 5:00 PM on Wednesday, September 30 is free with Dr. Omar Rahman. Shall I book it?');
  });

  it('"earlier than 6": the latest times before 6, not the morning', async () => {
    const r = await find({ visit_type_id: 'vt_quick', provider_id: 'prov_khan', from_date: '2026-09-30', from_time: '18:00', time_mode: 'before' });
    expect(r.slots.map((s) => s.when)).toEqual(['Wednesday, September 30, at 5:50 PM', 'Wednesday, September 30, at 5:40 PM']);
    expect(r.say_as).toBe('The nearest are 5:40 or 5:50 PM on Wednesday, September 30.');
  });

  it('a time outside the vet\'s hours: when they start, then the nearest', async () => {
    const r = await find({ provider_id: 'prov_morgan', from_date: '2026-10-02', from_time: '08:00', time_mode: 'at' });
    expect(r.say_as).toBe('Dr. Mara Vance starts at 9 on Fridays. The nearest are 9:00 or 9:20 AM on Friday, October 2.');
  });

  it('in Spanish: "a las 4:00 no, pero..."', async () => {
    const r = await find({ visit_type_id: 'vt_quick', provider_id: 'prov_rahman', from_date: '2026-09-30', from_time: '16:00', time_mode: 'at' }, { language: 'es' });
    expect(r.say_as).toBe('A las 4:00 no, pero el miércoles 30 de septiembre tengo a las 3:50 o 4:20 de la tarde.');
  });
});

describe('the true reason (item 4)', () => {
  it('a vet who does not do the visit: what they do, and who does', async () => {
    const r = await find({ visit_type_id: 'vt_vaccines', provider_id: 'prov_morgan', from_date: '2026-10-02' });
    expect(r.reason).toBe('doesnt_do_type');
    expect(r.slots).toEqual([]);
    expect(r.say_as).toBe('Dr. Mara Vance doesn\'t do vaccine appointment; her visits are sick visit and new patient exam. Dr. Omar Rahman and Dr. Leila Khan do vaccine appointment. Shall I look with them?');
    const es = await find({ visit_type_id: 'vt_vaccines', provider_id: 'prov_morgan', from_date: '2026-10-02' }, { language: 'es' });
    expect(es.say_as).toContain('no hace cita de vacunas');
  });

  it('not working that day: their days, then the times on them', async () => {
    const r = await find({ provider_id: 'prov_morgan', from_date: '2026-09-29' });
    expect(r.reason).toBe('not_working_that_day');
    expect(r.say_as).toMatch(/^Dr\. Mara Vance doesn't work on Tuesdays\. She's in Friday and Sunday\. On Friday, October 2, I have /);
  });

  it('fully booked that day: said, then the nearest after it', async () => {
    const busy = ClinicConfig.parse({ ...clinic, providers: clinic.providers.map((p) => (p.id === 'prov_morgan' ? { ...p, timeOff: [{ from: '2026-10-02', to: '2026-10-02', start: '08:00', end: '18:00' }] } : p)) });
    const r = await find({ provider_id: 'prov_morgan', from_date: '2026-10-02' }, { clinic: busy });
    expect(r.reason).toBe('fully_booked');
    expect(r.say_as).toMatch(/^Dr\. Mara Vance is fully booked on Friday, October 2\. The clinic's front desk is closed on Sundays, but Dr\. Mara Vance sees patients Sunday from 9 to 1\. On Sunday, October 4, I have /);
  });

  it('notice: the first day it can be booked', async () => {
    const notice = ClinicConfig.parse({ ...clinic, visitTypes: clinic.visitTypes.map((v) => (v.id === 'vt_sick' ? { ...v, noticeHours: 72 } : v)) });
    const r = await find({ provider_id: 'prov_rahman', from_date: '2026-09-29' }, { clinic: notice });
    expect(r.reason).toBe('notice');
    expect(r.say_as).toMatch(/^A sick visit needs 3 days' notice, so the first day I can book it is Thursday, October 1\./);
  });

  it('a holiday nobody works: closed', async () => {
    const r = await find({ provider_id: 'prov_rahman', from_date: '2026-11-26' });
    expect(r.reason).toBe('clinic_closed');
  });

  it('never "in the next two weeks": nothing at all says up to which day', async () => {
    const away = ClinicConfig.parse({ ...clinic, providers: clinic.providers.map((p) => (p.id === 'prov_khan' ? { ...p, timeOff: [{ from: '2026-09-01', to: '2026-12-31' }] } : p)) });
    const r = await find({ provider_id: 'prov_khan' }, { clinic: away });
    expect(r.slots).toEqual([]);
    expect(r.say_as).toBe('I can\'t find a free time with Dr. Leila Khan through Sunday, October 11.');
    expect(JSON.stringify(r)).not.toContain('two weeks');
  });

  it('any number of searches on one call: 15 in a row, every one answered', async () => {
    const c = await w.call('+13035550190', { clinic });
    for (let i = 0; i < 15; i++) {
      const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: 'prov_rahman', from_date: '2026-10-02', part_of_day: 'any', from_time: `${String(9 + (i % 9)).padStart(2, '0')}:00`, time_mode: 'at' } }]);
      expect(out.errors).toEqual([null]);
      expect((out.results[0]!.data.slots as unknown[]).length).toBeGreaterThan(0);
    }
    // the only "can't check more" in the prompt is about identity details, never times
    const prompt = systemPrompt(clinic, '');
    expect(prompt).toContain('there is no limit on how many times you look for times with find_slots');
    expect(prompt).not.toMatch(/cannot check more details on this call/);
  });
});

describe('a time asked for and free, with the pet found', () => {
  const findPet = async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Could Biscuit see Dr. Khan around 5 on Thursday?');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } }]);
    return c;
  };
  const at5 = (visit: string, extra: Record<string, unknown> = {}) => ({ tool: 'find_slots' as const, args: { visit_type_id: visit, provider_id: 'prov_khan', from_date: '2026-10-01', part_of_day: 'any', from_time: '17:00', time_mode: 'around', ...extra } });

  it('is staged at once, so the caller\'s yes books it; the text note is said with the first read-back only', async () => {
    const c = await findPet();
    const first = (await c.delegate([at5('vt_wellness')])).results[0]!.data;
    expect(first.proposed_slot_id).toBe('prov_khan@2026-10-01T23:00:00.000Z');
    expect(String(first.spoken)).toMatch(/^I have Thursday, October 1, at 5:00 PM with Dr\. Leila Khan for a wellness exam\. I'll text you/);
    // another time asked for on the same call: read back without the note again
    c.caller('What about 5:30 instead?');
    const second = (await c.delegate([{ tool: 'find_slots', args: { ...at5('vt_wellness').args, from_time: '17:30', time_mode: 'at' } }])).results[0]!.data;
    expect(String(second.spoken)).toBe('I have Thursday, October 1, at 5:30 PM with Dr. Leila Khan for a wellness exam. Shall I book it?');
    // and the planner can still only look
    const looked = (await c.delegate([at5('vt_wellness', { propose_if_exact: false })])).results[0]!.data;
    expect(looked.proposed_slot_id).toBeUndefined();
  });

  it('a booked visit changed to another kind keeps its time: its own 5:00 is not in its way', async () => {
    const c = await findPet();
    await c.delegate([at5('vt_wellness')]);
    c.readBack('Shall I book it?');
    c.caller('Yes.');
    expect((await c.delegate([{ tool: 'commit_pending', args: {} }])).results[0]!.data.booked).toBe(true);
    c.caller('That should be a sick visit, not a wellness exam.');
    c.state.memory.set('intent', 'move', 'model', c.state.turns.length);
    const again = (await c.delegate([at5('vt_sick')])).results[0]!.data;
    expect(again.exact).toEqual({ time: '17:00', free: true });
    expect(String(again.spoken)).toMatch(/^So I'd move Biscuit's sick visit from Thursday, October 1, at 5:00 PM to Thursday, October 1, at 5:00 PM/);
    c.readBack('Shall I go ahead?');
    c.caller('Yes.');
    expect((await c.delegate([{ tool: 'commit_pending', args: {} }])).results[0]!.data.booked).toBe(true);
    expect(c.state.outcome).toBe('rescheduled');
    const left = await w.backend.scheduler.upcoming(clinic.id, c.state.verifiedPatient!.id, zonedInstant('2026-09-28', '20:00', clinic.timezone));
    expect(left.filter((a) => a.providerId === 'prov_khan').map((a) => a.visitTypeId)).toEqual(['vt_sick']);
  });

  it('a vet who does not do a visit the planner chose: their own visits come back, to look again with', async () => {
    const r = await find({ visit_type_id: 'vt_wellness', provider_id: 'prov_morgan', from_date: '2026-10-02' }) as unknown as { their_visit_type_ids: string[]; note: string };
    expect(r.their_visit_type_ids).toEqual(['vt_sick', 'vt_new']);
    expect(r.note).toContain('If you chose the visit yourself, do not say say_as');
  });
});
