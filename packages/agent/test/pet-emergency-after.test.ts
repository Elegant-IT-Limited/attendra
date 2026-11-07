// SPDX-License-Identifier: AGPL-3.0-only
import { EMERGENCY_LINES, RIVERBEND_CLINIC } from '@attendra/core';
import { schema, seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// A pet emergency gets the pet's script, never the 911 line, and after it has been said once there is no loop
// (a tester clinic, 2026-11-03: "My dog Luna's throat is swelling" got 911, and a caller still asking to book was refused on every
// tool). The next step is the team now, or an urgent request; another pet's needs are answered as usual.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const open = { ...RIVERBEND_CLINIC, afterHours: 'book' as const, emergencyTransferEnabled: false };
// the calls are at 8 pm on a Monday: open late, so the front desk takes transfers
const openLate = { ...open, hours: { ...open.hours, '1': [{ open: '08:00', close: '22:00' }] } };
const instructions = (out: { type: string; content?: string }[]) => out.filter((o) => o.type === 'instructions').map((o) => o.content ?? '').join(' ');
const FIND = { tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: null, part_of_day: 'any' } } as const;
const SCRIPT = 'Please take your pet to Front Range Pet Emergency at 1200 Larkspur Avenue, Denver right away. If a person is hurt or in danger, call 911.';
const QUESTION = EMERGENCY_LINES.question('en');
/**
 * A red flag, the one question (batch 1b), the caller's yes, and the route said: the call is held as an emergency. These
 * clinics refer emergencies to a hospital (no on-call line), so the route is the hospital.
 */
function routed(c: Awaited<ReturnType<typeof w.call>>, said: string) {
  const flagged = instructions(c.caller(said));
  expect(flagged).toContain(QUESTION);
  c.assistant(QUESTION);
  const out = instructions(c.caller('Yes, please.'));
  c.assistant(SCRIPT);
  return out;
}

describe('the right script', () => {
  it('a pet\'s throat swelling gets the one question, then on a yes the pet\'s route (the hospital), never the 911 line', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    const asked = instructions(c.caller("My dog Luna's throat is swelling!"));
    expect(asked).toContain(QUESTION);
    expect(asked).not.toContain('Front Range Pet Emergency');
    expect(c.state.emergency).toBeNull();
    expect(c.state.emergencyCase?.kind).toBe('pet_breathing');
    c.assistant(QUESTION);
    const out = instructions(c.caller('Yes!'));
    expect(out).toContain('Front Range Pet Emergency');
    expect(out).not.toContain('If this is a medical emergency');
    expect(c.state.emergency?.kind).toBe('pet_breathing');
  });

  it('in Spanish too', async () => {
    const c = await w.call('+17205550172', { clinic: { ...open, languages: ['en', 'es'] } });
    const asked = instructions(c.caller('A mi perra Luna se le está hinchando la garganta.'));
    expect(asked).toContain(EMERGENCY_LINES.question('es'));
    c.assistant(EMERGENCY_LINES.question('es'));
    const out = instructions(c.caller('Sí, por favor.'));
    expect(out).toContain('Por favor lleve a');
    expect(out).toContain('Front Range Pet Emergency');
    expect(c.state.emergency?.kind).toBe('pet_breathing');
  });

  it('a person in danger still gets the emergency number', async () => {
    for (const said of ["I can't breathe, my throat is swelling", 'My husband is having chest pain']) {
      const c = await w.call('+17205550172', { clinic: open });
      const out = instructions(c.caller(said));
      expect(out, said).toContain('call 911 right away');
      expect(out, said).not.toContain('Front Range Pet Emergency');
    }
  });
});

describe('after the pet script', () => {
  it('a caller who still wants a visit for that pet is offered the team now, never the hospital again, and booking stays refused', async () => {
    const c = await w.call('+17205550172', { clinic: openLate });
    routed(c, "Biscuit can't breathe properly.");
    c.caller("Okay, but I'd like an appointment for him.");
    const first = await c.delegate([FIND]);
    expect(first.errors).toEqual(['emergency_in_progress']);
    const said = JSON.stringify(first.results[0]!.data);
    // the pet's name is not known yet (nothing has looked it up): "your pet"
    expect(said).toContain("I can't book a routine visit for your pet while this is going on. I can put you through to our team right now.");
    expect(said).toContain('transfer_call with front_desk');
    expect(said).not.toContain('in danger right now');
    // finding him is fine; his visit is still refused, with the same next step
    const again = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } }, FIND]);
    expect(again.errors).toEqual([null, 'emergency_in_progress']);
    const transfer = await c.delegate([{ tool: 'transfer_call', args: { target: 'front_desk' } }]);
    expect(transfer.results[0]!.ok).toBe(true);
  });

  it('closed, the next step is an urgent request, flagged urgent for the team', async () => {
    const closed = { ...RIVERBEND_CLINIC, emergencyTransferEnabled: false }; // 8 pm: closed, and it takes requests
    const c = await w.call('+17205550172', { clinic: closed });
    routed(c, 'My cat is choking.');
    c.caller('Can you book her in for tomorrow?');
    const out = await c.delegate([FIND]);
    expect(out.errors).toEqual(['emergency_in_progress']);
    expect(JSON.stringify(out.results[0]!.data)).toContain('I can send our team an urgent message to call you back as soon as they can.');
    const request = await c.delegate([{ tool: 'create_callback', args: { reason: 'Cat choking, owner wants a visit', callback_number: null } }]);
    expect(request.results[0]!.data).toMatchObject({ urgent: true, spoken: "I've sent that to the team as urgent, and someone will call you back as soon as they can." });
    const [task] = (await w.t.db.select().from(schema.tasks)).filter((t) => t.id === request.results[0]!.data.task_id);
    expect(task!.urgent).toBe(true);
  });

  it('another pet\'s visit is answered as usual, while the pet in danger\'s stays refused', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    routed(c, "My dog Biscuit's throat is swelling!");
    expect(c.state.emergencyPet).toEqual({ name: null, species: 'dog' });
    c.caller("We're going now. Quick question, can I book my cat Mochi for her shots next week?");
    const other = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Mochi', phone: null } }, FIND]);
    expect(other.errors).toEqual([null, null]);
    expect(c.state.offered.size).toBeGreaterThan(0);
    // back to the dog: refused
    const dog = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } }, FIND]);
    expect(dog.errors).toEqual([null, 'emergency_in_progress']);
  });

  it('a pet named before the red flag is the one in danger', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: null } }]);
    c.caller("Biscuit's tongue is swelling up");
    expect(c.state.emergencyCase?.pet).toEqual({ name: 'Biscuit', species: 'dog' });
  });

  it('plans nothing on the red flag itself once the script is said: no unasked transfer (a live run, 2026-11-15)', async () => {
    const c = await w.call('+17205550172', { clinic: openLate });
    routed(c, "Biscuit can't breathe properly.");
    const out = await c.delegate([{ tool: 'transfer_call', args: { target: 'on_call' } }]);
    expect(out.results).toEqual([]);
    expect(out.some((o) => o.type === 'transfer')).toBe(false);
    expect(JSON.stringify(out)).toContain('wait for them to speak');
  });

  it('never sends the caller to the on-call line itself in an animal emergency: the next step instead', async () => {
    const c = await w.call('+17205550172', { clinic: openLate });
    routed(c, "Biscuit can't breathe properly.");
    c.caller('Can I talk to someone?');
    const out = await c.delegate([{ tool: 'transfer_call', args: { target: 'on_call' } }]);
    expect(out.errors).toEqual(['emergency_in_progress']);
    expect(JSON.stringify(out.results[0]!.data)).toContain('I can put you through to our team right now');
    const desk = await c.delegate([{ tool: 'transfer_call', args: { target: 'front_desk' } }]);
    expect(desk.errors).toEqual([null]);
  });
});
