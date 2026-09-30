import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); });
afterAll(() => w.t.close());

describe('events from calls', () => {
  it('a booking the caller said yes to is appointment.booked, with ids and times and no personal details', async () => {
    const c = await w.call();
    c.caller('Hi, this is Maria Delgado, born March 4th 1985. I need a sick visit.');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
    ]);
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null } }]);
    c.assistant('Tuesday at 8 with Dr. Okafor. Shall I book it?');
    c.caller('Yes please.');
    await c.delegate([{ tool: 'commit_pending', args: {} }]);
    const booked = w.events.find((e) => e.type === 'appointment.booked')!;
    expect(booked.data).toMatchObject({ patientId: w.patientIds.maria, providerId: 'prov_okafor', visitTypeId: 'vt_sick', by: 'assistant', callId: c.callId });
    expect(booked.key).toBe(booked.data.appointmentId);
    expect(JSON.stringify(w.events)).not.toMatch(/Maria|Delgado|1985|5550147/);
  });

  it('a refill request is request.created, once, however often the planner asks', async () => {
    const c = await w.call('+13035550163');
    c.caller('James Whitaker, 9/9/1962, I need my lisinopril refilled.');
    const refill = { tool: 'create_refill_request' as const, args: { medication: 'lisinopril', pharmacy: 'Walgreens', callback_number: '+13035550163' } };
    await c.delegate([{ tool: 'verify_caller', args: { full_name: 'James Whitaker', date_of_birth: '9/9/1962' } }, refill]);
    await c.delegate([refill]);
    const created = w.events.filter((e) => e.type === 'request.created');
    expect(created).toHaveLength(1);
    expect(created[0]!.data).toMatchObject({ type: 'refill', callId: c.callId });
    expect(JSON.stringify(created)).not.toContain('lisinopril');
  });

  it('a booking still stands when the event cannot be queued', async () => {
    const failing = w.backend.events.emit;
    w.backend.events.emit = async () => { throw new Error('queue down'); };
    try {
      const c = await w.call('+13035550163');
      c.caller('James Whitaker, September 9 1962, I want to book.');
      await c.delegate([
        { tool: 'verify_caller', args: { full_name: 'James Whitaker', date_of_birth: 'September 9 1962' } },
        { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
      ]);
      await c.delegate([{ tool: 'propose_booking', args: { slot_id: [...c.state.offered.keys()][2]!, replaces_appointment_id: null } }]);
      c.assistant('Shall I book it?');
      c.caller('Yes.');
      await c.delegate([{ tool: 'commit_pending', args: {} }]);
      expect(c.state.outcome).toBe('booked');
    } finally {
      w.backend.events.emit = failing;
    }
  });
});
