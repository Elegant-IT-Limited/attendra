import { PACKS, RIVERBEND_CLINIC, Texting } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// full dates on every offer, read-back, move and text; a time-only move keeps the day; the asked day's nearest times
// first; "next Wednesday" asked once when it could be either (2026-11-14). The test clock is Monday 28 September 2026.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const, texting: { ...Texting.parse({}), enabled: true } };
const data = (out: { results: { data: Record<string, unknown> }[] }, i = 0) => out.results[i]!.data;

describe('a booking, then "make it 4" on the same call', () => {
  it('keeps the day, says both times in full, and the text says the move', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, can I book Biscuit for a wellness exam on Wednesday at 5?');
    const found = await c.delegate([
      { tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: null, part_of_day: 'any', from_time: null } },
    ]);
    // the day and the time the caller said, filled from the call memory; that day's nearest times, 5:00 first
    expect(data(found, 1).filled_from_memory).toEqual(['from_date', 'from_time']);
    const first = (data(found, 1).slots as { slot_id: string; when: string }[])[0]!;
    expect(first.when).toBe('Wednesday, September 30, at 5:00 PM');
    // the direct answer first: the time asked for is free
    expect(String(data(found, 1).say_as)).toMatch(/^Yes, 5:00 PM on Wednesday, September 30 is free with Dr\. /);
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: first.slot_id, replaces_appointment_id: null } }]);
    c.assistant('Shall I book it?');
    c.caller('Yes.');
    expect(data(await c.delegate([{ tool: 'commit_pending', args: {} }])).booked).toBe(true);

    c.caller('Actually, can you make it 4?');
    const moved = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: null, part_of_day: 'any', from_time: null } }]);
    expect(data(moved).filled_from_memory).toEqual(['from_date', 'from_time']);
    const four = (data(moved).slots as { slot_id: string; when: string }[])[0]!;
    expect(four.when).toBe('Wednesday, September 30, at 4:00 PM');
    const proposed = await c.delegate([{ tool: 'propose_booking', args: { slot_id: four.slot_id, replaces_appointment_id: null } }]);
    expect(data(proposed).filled_from_memory).toEqual(['replaces_appointment_id']);
    expect(c.state.pending?.readback).toBe("move Biscuit's wellness exam from Wednesday, September 30, at 5:00 PM to Wednesday, September 30, at 4:00 PM with Dr. Marcus Bell");
    expect(String(data(proposed).spoken)).toMatch(/^So I'd move Biscuit's wellness exam from .* Shall I go ahead\?$/);
    c.assistant('Shall I go ahead?');
    c.caller('Yes please.');
    const done = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(c.state.outcome).toBe('rescheduled');
    expect(data(done).booked).toBe(true);
    expect(w.sms.at(-1)).toMatchObject({ template: 'change_confirmed', when: 'Wednesday, September 30, at 4:00 PM' });
  });
});

describe('a move to another day', () => {
  it('says how the day shifts', () => {
    expect(PACKS.en.readbackBooking({ when: 'Wednesday, October 7, at 4:00 PM', provider: 'Dr. Elena Ruiz', providerKind: 'person', visit: 'wellness exam', replacing: 'Wednesday, September 30, at 5:00 PM', pet: 'Biscuit', shift: "that's one week later, Wednesday, October 7" }))
      .toBe("move Biscuit's wellness exam from Wednesday, September 30, at 5:00 PM to Wednesday, October 7, at 4:00 PM with Dr. Elena Ruiz, that's one week later, Wednesday, October 7");
    expect(PACKS.es.readbackBooking({ when: 'el miércoles 7 de octubre a las 4:00 de la tarde', provider: 'Dra. Elena Ruiz', providerKind: 'person', visit: 'chequeo general', replacing: 'el miércoles 30 de septiembre a las 5:00 de la tarde', pet: 'Biscuit', shift: 'es una semana después, el miércoles 7 de octubre' }))
      .toBe('cambiar la cita de Biscuit del miércoles 30 de septiembre a las 5:00 de la tarde al miércoles 7 de octubre a las 4:00 de la tarde con Dra. Elena Ruiz; es una semana después, el miércoles 7 de octubre');
    expect(PACKS.es.spoken.readback({ readback: 'cambiar la cita de Biscuit del lunes al martes', textNote: null, move: true })).toBe('Entonces, quiere cambiar la cita de Biscuit del lunes al martes. ¿Hago el cambio?');
  });

  it('a change text says both times, in Spanish without "el el"', () => {
    const v = { clinic: 'Riverbend', when: 'el miércoles 7 de octubre a las 4:00 de la tarde', from: 'el miércoles 30 de septiembre a las 5:00 de la tarde', clinicPhone: '(720) 555-0170', pet: 'Biscuit' };
    expect(PACKS.es.sms.change_confirmed(v)).toContain('se cambió del miércoles 30 de septiembre a las 5:00 de la tarde al miércoles 7 de octubre a las 4:00 de la tarde.');
    expect(PACKS.es.sms.booking_confirmed(v)).toContain('es el miércoles 7 de octubre a las 4:00 de la tarde.');
    expect(PACKS.en.sms.change_confirmed({ ...v, when: 'Wednesday, October 7, at 4:00 PM', from: 'Wednesday, September 30, at 5:00 PM' })).toContain("Biscuit's visit has moved from Wednesday, September 30, at 5:00 PM to Wednesday, October 7, at 4:00 PM.");
  });
});

describe('"next Wednesday" said on a Monday', () => {
  it('is asked once, "this Wednesday or the one after", never guessed', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Can I bring Biscuit in next Wednesday?');
    const asked = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-09-30', part_of_day: 'any' } }]);
    expect(asked.errors).toEqual(['which_week']);
    expect(String(data(asked).say)).toContain('"This Wednesday, September 30, or Wednesday, October 7?"');
    c.caller('The one after, the 7th.');
    const slots = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-10-07', part_of_day: 'any' } }]);
    expect(slots.errors).toEqual([null]);
    expect(String(data(slots).say_as)).toMatch(/^On Wednesday, October 7, I have/);
  });

  it('"this Wednesday" is the coming one, with no question', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Can I bring Biscuit in this Wednesday?');
    const slots = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(slots.errors).toEqual([null]);
    expect(data(slots).filled_from_memory).toEqual(['from_date']);
    expect(String(data(slots).say_as)).toMatch(/^On Wednesday, September 30, I have/);
  });
});
