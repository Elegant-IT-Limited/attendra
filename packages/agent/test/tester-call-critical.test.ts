import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// A tester's 14-minute call on the demo clinic (2026-11-24), the critical items, at the agent: made-up names and numbers.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };

describe('T1: a pet\'s details only as the caller said them', () => {
  it('T1: refuses a kind of animal the caller never said ("Can you hear me?"), and asks for it', async () => {
    const c = await w.call('+13035550161', { clinic });
    c.caller('Hi, I want to register a new pet, her name is Tango. My name is Corin Vale.');
    c.assistant('Sure. What kind of animal is Tango?');
    c.caller('Can you hear me?');
    const out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Tango', owner_name: 'Corin Vale', species: 'cat', sex: 'female', birthday_or_age: null, phone: null } }]);
    expect(out.errors).toEqual(['ask_species']);
    expect(String(out.results[0]!.data.say)).toContain('What kind of animal is Tango?');
    expect(c.state.verifiedPatient).toBeNull();
  });

  it('T1: refuses an age the caller never gave ("Sí, eso"), and asks for it, in Spanish', async () => {
    const c = await w.call('+13035550162', { clinic });
    c.caller('Hola, quiero registrar a mi perra nueva, se llama Pippa. Soy Corin Vale.');
    c.assistant('¿Cuántos años tiene Pippa?');
    c.caller('Sí, eso.');
    const out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Pippa', owner_name: 'Corin Vale', species: 'perro', sex: 'female', birthday_or_age: 'dos años', phone: null } }]);
    expect(out.errors).toEqual(['ask_age']);
    expect(String(out.results[0]!.data.say)).toContain('¿Cuántos años tiene Pippa');
    expect(c.state.verifiedPatient).toBeNull();
  });

  it('T1: a second pet never takes the first pet\'s kind, sex or age from the call memory ("Perdón")', async () => {
    const c = await w.call('+13035550163', { clinic });
    c.caller('I want to register my new cat Tango, she is two years old. I am Corin Vale.');
    const first = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Tango', owner_name: 'Corin Vale', species: 'cat', sex: 'female', birthday_or_age: 'two years old', phone: null } }]);
    expect(first.errors).toEqual([null]);
    c.assistant('Tango is registered. Anything else?');
    c.caller('Yes, I want to add another pet, Pico.');
    c.assistant('What kind of animal is Pico?');
    c.caller('Perdón.');
    // the model leaves the details out: the memory must not fill them from Tango
    const second = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Pico', owner_name: null, species: null, sex: null, birthday_or_age: null, phone: null } }]);
    expect(second.errors[0] ?? 'registered with the first pet\'s details').toMatch(/^(?:pet_species|ask_species)$/);
    expect(c.state.verifiedPatient?.firstName).toBe('Tango');
  });

  it('T1: what the caller did say is taken, in their words or as a yes to the question that named it', async () => {
    const c = await w.call('+13035550164', { clinic });
    c.caller('Hi, I am Corin Vale, I have a new puppy called Bolt.');
    c.assistant('Is Bolt a boy or a girl?');
    c.caller("He's a boy.");
    c.assistant('Is Bolt about four months old?');
    c.caller('Yes.');
    const out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Bolt', owner_name: 'Corin Vale', species: 'dog', sex: 'male', birthday_or_age: 'about four months', phone: null } }]);
    expect(out.errors).toEqual([null]);
    expect(out.results[0]!.data.registered).toBe(true);
  });
});

/** Words no tool result may hand the voice: internal state said out loud (T2, T5). */
const INTERNAL = /tentative|won'?t be used|will not be (?:done|used)|waiting (?:to confirm|for (?:a|their) yes)|pending change|still waiting|contact the clinic|call the clinic directly|replaces the change|instead|booked on this call|means that one/i;

describe('T2, T5: a stale change is replaced silently, never explained', () => {
  const findSlots = { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-09-29', part_of_day: 'morning' } } as const;

  it('T2: a new proposal replaces the one read back with no word about the old one, and only the new one is booked', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen. Can Biscuit come in tomorrow morning for a sick visit?');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }, findSlots]);
    c.caller('The first one.');
    await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null }) }]);
    c.readBack('Shall I book it?');
    c.caller('Hmm, actually the second one is better.');
    const second = await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][1]!, replaces_appointment_id: null }) }]);
    expect(second.errors).toEqual([null]);
    expect(JSON.stringify(second.results[0]!.data)).not.toMatch(INTERNAL);
    expect(c.state.pending).toMatchObject({ kind: 'book', slot: { id: [...c.state.offered.keys()][1] } });
  });

  it('T5: a question while a change waits for a yes gets the plain question to settle it, and no internal state', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen. Can Biscuit come in tomorrow morning for a sick visit?');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }, findSlots]);
    c.caller('The first one.');
    await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null }) }]);
    c.readBack('Shall I book it?');
    c.caller('Wait, what about the afternoon?');
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-09-29', part_of_day: 'afternoon' } }]);
    const data = JSON.stringify(out.results[0]!.data);
    expect(data).toContain('And do you still want me to book');
    expect(data).not.toMatch(INTERNAL);
  });

  it('T2: "contact the clinic directly" said while a time is ready to book is corrected at once', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen. Can Biscuit come in tomorrow morning for a sick visit?');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }, findSlots]);
    c.caller('The first one.');
    await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null }) }]);
    const out = c.agent.onAgentTranscript("I can't finalize the booking from here. Please contact the clinic directly.", 99_000, 99_900);
    expect(out.map((o) => (o.type === 'instructions' ? o.content : '')).join(' ')).toMatch(/can be booked on this call/);
  });
});

describe('T3: a named vet, day or pet beats "the one just booked"', () => {
  /** Books Biscuit with one vet, by the agent, on tomorrow's or Wednesday's first free time. */
  const book = async (c: Awaited<ReturnType<typeof w.call>>, provider: string, date: string, visit = 'vt_sick') => {
    c.caller(`Can we see that vet on ${date}?`);
    const found = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: visit, provider_id: provider, from_date: date, part_of_day: 'any' } }]);
    expect(found.errors).toEqual([null]);
    c.caller('The first one.');
    await c.delegate([{ tool: 'propose_booking', args: () => ({ slot_id: (found.results[0]!.data.slots as { slot_id: string }[])[0]!.slot_id, replaces_appointment_id: null }) }]);
    c.readBack('Shall I book it?');
    c.caller('Yes.');
    const done = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(done.errors).toEqual([null]);
  };

  it('T3: "cancel the booking with Dr. Ruiz" cancels that one, not the visit booked last on this call', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen, for Biscuit.');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }]);
    await book(c, 'prov_ruiz', '2026-09-29');
    await book(c, 'prov_bell', '2026-09-30', 'vt_wellness');
    const upcoming = await w.backend.scheduler.upcoming(clinic.id, c.state.verifiedPatient!.id, new Date('2026-09-28T00:00:00Z'));
    const ruiz = upcoming.find((a) => a.providerId === 'prov_ruiz')!;
    c.assistant('Is there anything else?');
    c.caller('I had another booking with Dr. Elena, just cancel that booking.');
    const out = await c.delegate([{ tool: 'list_appointments', args: {} }, { tool: 'propose_cancellation', args: { appointment_id: ruiz.id } }]);
    expect(out.errors).toEqual([null, null]);
    expect(c.state.pending).toMatchObject({ kind: 'cancel', appointmentId: ruiz.id });
  });

  it('T3: with no visit named, "cancel it" right after a booking is still the visit just booked, and the refusal explains nothing', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen, for Mochi.');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Mochi' } }]);
    await book(c, 'prov_ruiz', '2026-10-01');
    await book(c, 'prov_bell', '2026-10-02', 'vt_wellness');
    const upcoming = await w.backend.scheduler.upcoming(clinic.id, c.state.verifiedPatient!.id, new Date('2026-09-28T00:00:00Z'));
    const ruiz = upcoming.find((a) => a.providerId === 'prov_ruiz')!;
    c.caller('Actually, cancel it.');
    const out = await c.delegate([{ tool: 'propose_cancellation', args: { appointment_id: ruiz.id } }]);
    expect(out.errors).toEqual(['which_visit']);
    expect(JSON.stringify(out.results[0]!.data)).not.toMatch(INTERNAL);
  });
});

describe('T9: the record of what was said', () => {
  it('T9: two sentences that came with no space between them are recorded with one', async () => {
    const { CallState } = await import('../src');
    const s = new CallState();
    s.addTranscript('agent', 'We can wrap up smoothly.This demo call ends in about a minute.', 0, 900);
    expect(s.turns[0]!.text).toBe('We can wrap up smoothly. This demo call ends in about a minute.');
    s.addTranscript('caller', 'Okay.', 1000, 1200);
    s.addTranscript('agent', 'Thanks for trying the demo.', 1300, 1500);
    s.addTranscript('agent', 'Goodbye.', 1600, 1800);
    expect(s.turns.at(-1)!.text).toBe('Thanks for trying the demo. Goodbye.');
  });
});
