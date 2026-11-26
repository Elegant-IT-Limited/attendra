import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// CQ2-VAPI8 follow-up (review 3): the visit just booked is known from the tool result the model saw, on every path.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };

describe('CQ2-VAPI8: commit_pending returns the appointment id it booked', () => {
  it('CQ2-VAPI8-review3: a booking\'s result carries appointment_id, the id list_appointments gives', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen, for Biscuit.');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }]);
    const found = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-10-06', part_of_day: 'any' } }]);
    c.caller('The first one.');
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: (found.results[0]!.data.slots as { slot_id: string }[])[0]!.slot_id, replaces_appointment_id: null } }]);
    c.readBack('Shall I book it?');
    c.caller('Yes.');
    const done = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    const listed = await c.delegate([{ tool: 'list_appointments', args: {} }]);
    const ids = (listed.results[0]!.data.appointments as { appointment_id: string }[]).map((a) => a.appointment_id);
    expect(done.results[0]!.data.appointment_id).toBeTruthy();
    expect(ids).toContain(done.results[0]!.data.appointment_id);
  });
});
