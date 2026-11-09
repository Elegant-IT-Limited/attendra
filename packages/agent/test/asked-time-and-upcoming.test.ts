import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// Note 45 (test calls, 2026-11-09), with made-up names and numbers. The test clock is Monday 28 September 2026.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
type Slot = { slot_id: string; when: string };

describe('a time asked for that is not the one read back (A3: asked for 9:30, heard 9:00 with no word about it)', () => {
  it('says the asked time is not free before the read-back, once', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Can I book Biscuit for a wellness exam on Wednesday at 9:30?');
    const found = await c.delegate([
      { tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } },
      // the model looked for the day without the time
      { tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-09-30', part_of_day: 'any', from_time: null, time_mode: 'earliest', propose_if_exact: false } },
    ]);
    const other = (found.results[1]!.data.slots as Slot[]).find((s) => !s.when.includes('9:30'))!;
    const proposed = await c.delegate([{ tool: 'propose_booking', args: { slot_id: other.slot_id, replaces_appointment_id: null } }]);
    expect(String(proposed.results[0]!.data.spoken)).toMatch(/^9:30 AM isn't free\. /);
    expect(String(proposed.results[0]!.data.say)).toMatch(/^Say first, in these words: "9:30 AM isn't free\." Then: /);
    // the same time proposed again: not said twice
    const again = (found.results[1]!.data.slots as Slot[]).filter((s) => !s.when.includes('9:30'))[1]!;
    const second = await c.delegate([{ tool: 'propose_booking', args: { slot_id: again.slot_id, replaces_appointment_id: null } }]);
    expect(String(second.results[0]!.data.spoken)).not.toContain("isn't free");
  });

  it('says nothing of the kind when the time read back is the one asked for, or none was asked', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Can I book Biscuit for a wellness exam on Thursday?');
    const found = await c.delegate([
      { tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-10-01', part_of_day: 'any', from_time: null } },
    ]);
    const slot = (found.results[1]!.data.slots as Slot[])[0]!;
    const proposed = await c.delegate([{ tool: 'propose_booking', args: { slot_id: slot.slot_id, replaces_appointment_id: null } }]);
    expect(String(proposed.results[0]!.data.spoken)).not.toContain("isn't free");
  });
});

describe('a pet that already has a visit booked (note 45)', () => {
  it('hears about it before the times for another, once per call, and only once the number has found it', async () => {
    // book one first
    const first = await w.call('+17205550172', { clinic });
    first.caller('Can I book Biscuit for a wellness exam on Friday at 10?');
    const f = await first.delegate([
      { tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-10-02', part_of_day: 'any', from_time: '10:00', time_mode: 'at', propose_if_exact: false } },
    ]);
    // nothing is said about a visit on the call that is booking its first one
    expect(String(f.results[1]!.data.say_as)).not.toContain('already has a visit booked');
    const ten = (f.results[1]!.data.slots as Slot[])[0]!;
    await first.delegate([{ tool: 'propose_booking', args: { slot_id: ten.slot_id, replaces_appointment_id: null } }]);
    first.readBack('Shall I book it?');
    first.caller('Yes.');
    expect((await first.delegate([{ tool: 'commit_pending', args: {} }])).results[0]!.data.booked).toBe(true);
    // a visit booked on this same call is not "already booked" when they ask for another
    const more = await first.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any', from_time: null } }]);
    expect(String(more.results[0]!.data.say_as)).not.toContain('already has a visit booked');

    // the next call: the visit is said first, then the times
    const c = await w.call('+17205550172', { clinic });
    c.caller('I need to book Biscuit in for a sick visit.');
    const found = await c.delegate([
      { tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any', from_time: null } },
    ]);
    const sayAs = String(found.results[1]!.data.say_as);
    expect(sayAs).toMatch(/^Biscuit already has a visit booked: wellness exam, Friday, October 2, at 10:00 AM, with Dr\. [A-Z]/);
    expect(String(found.results[1]!.data.note)).toContain('replaces_appointment_id');
    const again = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-10-05', part_of_day: 'any', from_time: null } }]);
    expect(String(again.results[0]!.data.say_as)).not.toContain('already has a visit booked');
  });
});
