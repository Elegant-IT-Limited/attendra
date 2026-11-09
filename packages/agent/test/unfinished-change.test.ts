import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// A read-back with no clear yes, then the caller hangs up: the change becomes a request for the team (note 45, A4: a test
// call said "Okay, bye" after its read-back, and nothing was booked or asked of the team). Made-up names and numbers.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const tasksOf = async (callId: string) => {
  await w.t.client.query(`select set_config('app.clinic_id', $1, false)`, [clinic.id]);
  return (await w.t.client.query(`select type, status, details_enc is not null as has_details from tasks where call_id = $1`, [callId])).rows;
};

describe('a change read back and never confirmed', () => {
  it('becomes one request for the team when the call ends, and the call is a request taken', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Can I book Biscuit for a wellness exam on Wednesday at 5?');
    const found = await c.delegate([
      { tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: null, part_of_day: 'any', from_time: null } },
    ]);
    const slot = (found.results[1]!.data.slots as { slot_id: string }[])[0]!;
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: slot.slot_id, replaces_appointment_id: null } }]);
    c.readBack('Shall I book it?');
    c.caller('Ja, ok.');
    const no = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(no.errors).toEqual(['no_clear_yes']);
    c.caller('Okay, bye.');
    expect(await tasksOf(c.callId)).toEqual([]);

    await c.agent.onCallEnd();
    expect(await tasksOf(c.callId)).toEqual([{ type: 'callback', status: 'open', has_details: true }]);
    expect(c.state.outcome).toBe('task_created');
    // once: the close may be reached twice (the socket, then the engine's own close)
    await c.agent.onCallEnd();
    expect(await tasksOf(c.callId)).toHaveLength(1);
  });

  it('asks nothing of the team when nothing was waiting for a yes', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('What time do you close today?');
    await c.agent.onCallEnd();
    expect(await tasksOf(c.callId)).toEqual([]);
    expect(c.state.outcome).toBe('abandoned');
  });

  it('asks nothing more once the change was made', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Can I book Biscuit for a wellness exam on Thursday at 4?');
    const found = await c.delegate([
      { tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: null, part_of_day: 'any', from_time: null } },
    ]);
    const slot = (found.results[1]!.data.slots as { slot_id: string }[])[0]!;
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: slot.slot_id, replaces_appointment_id: null } }]);
    c.readBack('Shall I book it?');
    c.caller('Yes please.');
    expect((await c.delegate([{ tool: 'commit_pending', args: {} }])).results[0]!.data.booked).toBe(true);
    await c.agent.onCallEnd();
    expect(await tasksOf(c.callId)).toEqual([]);
    expect(c.state.outcome).toBe('booked');
  });
});
