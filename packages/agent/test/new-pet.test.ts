import { newToClinic, RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CallState, type Outbound } from '../src';
import { emptyPromise, stateLine } from '../src/planner';
import { world } from './support';

// Riverbend's pets, with the clinic taking bookings at any hour so a found or added pet can book on the test's clock
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const pets = async () => Number((await w.t.db.execute(sql`select count(*)::int as n from patients where clinic_id = ${clinic.id}`)).rows[0]!.n);
const say = (out: { results: { data: Record<string, unknown> }[] }) => out.results.map((r) => String(r.data.say ?? '')).join(' ');

describe('a caller who says the pet is new (2026-11)', () => {
  it('reads "new" and "on file after all" in English and Spanish, and a yes to "is it new?"', () => {
    for (const [said, verdict] of [
      ["No, I told you she's not in your system, she's a new client", 'new'], ['I want to register my pet', 'new'], ['Orbit is new', 'new'],
      ["He's not registered", 'new'], ['she has never been to your clinic', 'new'],
      ['Es nueva, nunca ha venido', 'new'], ['No está registrado', 'new'], ['Quiero registrar a mi perro', 'new'],
      ["She's not new, she came last year", 'on_file'], ['maybe she is already in your system', 'on_file'],
      ['No es nuevo, ya ha venido antes', 'on_file'], ['Ya es paciente', 'on_file'],
      ["I'd like to bring my puppy in for a first check-up", 'new'], ['We just adopted a kitten', 'new'],
      ['Quiero traer a mi cachorro para su primera consulta', 'new'], ['Acabamos de adoptar una gata', 'new'],
      ["What's new?", null], ["I've got a new phone number", null], ['Hola, quiero una cita para Biscuit', null],
      ["I'll take the first appointment available", null], ['Quiero la primera cita disponible', null],
    ] as const) expect(newToClinic(said), said).toBe(verdict);
    const s = new CallState();
    s.addTranscript('agent', 'I couldn\'t find Orbit. Is Orbit new to the clinic?', 0, 900);
    s.addTranscript('caller', 'Yes.', 1000, 1500);
    expect(s.saidNew()).toBe('new');
    const es = new CallState();
    es.addTranscript('agent', '¿Orbit es nueva en la clínica?', 0, 900);
    es.addTranscript('caller', 'Sí.', 1000, 1500);
    expect(es.saidNew()).toBe('new');
    es.addTranscript('agent', 'Muy bien.', 1600, 1900);
    es.addTranscript('caller', 'Bueno, puede que ya esté registrada.', 2000, 2500);
    expect(es.saidNew()).toBe('on_file'); // the latest word wins: she may be on file after all
  });

  it('never looks the pet up, asks each detail once, and adds it with no lookup first', async () => {
    const c = await w.call('+17205550181', { clinic });
    c.caller("Hi, I'm Nora Quinn, I want to register my dog Pixel. She's new.");
    const looked = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Nora Quinn', pet_name: 'Pixel', phone: null } }]);
    expect(looked.errors).toEqual(['pet_is_new']);
    expect(c.state.verifyAttempts).toBe(0); // refused before any lookup
    // what the caller said is kept for the planner: never asked again, and a correction replaces it
    expect(stateLine(c.state, clinic)).toContain('details the caller gave: owner\'s name Nora Quinn, pet\'s name Pixel');
    expect(stateLine(c.state, clinic)).toContain('never look it up with verify_caller');
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Pixel', owner_name: 'Nora Quinn', species: 'dog', sex: 'female', birthday_or_age: 'about a year', phone: null } }]);
    expect(added.errors).toEqual([null]);
    expect(added.results[0]!.data.registered).toBe(true);
    expect(c.state.verifiedPatient).toMatchObject({ firstName: 'Pixel', isNew: true });
    expect(c.state.verifyAttempts).toBe(1); // the check it ran first counts as a try, like verify_caller's
    expect(stateLine(c.state, clinic)).toContain('kind of animal dog, pet\'s sex female, pet\'s age or birthday about a year');
    c.state.remember({ birthday_or_age: 'two years' });
    expect(stateLine(c.state, clinic)).toContain('pet\'s age or birthday two years');
  });

  it('keeps the kind of animal said before the lookup, and looks for a new pet\'s first visit before it is added (live eval, 2026-11-06)', async () => {
    const c = await w.call('+17205550183', { clinic });
    c.caller('Hi, I\'m Leo Grant, I\'d like to book my cat Mango in.');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Leo Grant', pet_name: 'Mango', phone: null, species: 'cat' } }]);
    expect(stateLine(c.state, clinic)).toContain('kind of animal cat');
    // "a first check-up" for a puppy is a new pet: its times are a new patient's, so the one picked still fits once it is added
    const p = await w.call('+17205550184', { clinic });
    p.caller('Hi, I\'d like to bring my puppy in for a first check-up this afternoon.');
    const looked = await p.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: null, from_time: '13:00', part_of_day: 'any' } }]);
    expect(looked.errors).toEqual(['new_patient_visit_type']);
  });

  it('finds a pet already on file instead of adding it twice, and tells the caller no more than the lookup would', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller("I'm Linh Nguyen, I want to register my dog Biscuit, he's new.");
    const before = await pets();
    const out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Biscuit', owner_name: 'Linh Nguyen', species: 'dog', sex: 'male', birthday_or_age: 'about five', phone: null } }]);
    expect(out.results[0]!.data).toMatchObject({ verified: true, already_a_patient: true });
    expect(c.state.verifiedPatient).toMatchObject({ id: w.patientIds.biscuit, isNew: false });
    expect(await pets()).toBe(before);
  });

  it('looks the pet up again once the caller says it may be on file after all', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller("Biscuit is new, he's not registered.");
    expect((await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit', phone: null } }])).errors).toEqual(['pet_is_new']);
    c.assistant('No problem. How old is Biscuit?');
    c.caller('Actually he might already be in your system, we came last year.');
    const found = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit', phone: null } }]);
    expect(found.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.id).toBe(w.patientIds.biscuit);
  });

  it('with no caller ID, asks once for the best number to reach them, in the caller\'s language, never for the number on the pet\'s file', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller("I'm Ray Chen, my dog Waffles is new.");
    const out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Waffles', owner_name: 'Ray Chen', species: 'dog', sex: 'male', birthday_or_age: '3 years', phone: null } }]);
    expect(out.errors).toEqual(['phone_required']);
    expect(say(out)).toContain('Ask once, in these words: "What\'s the best number to reach you?"');
    expect(say(out)).not.toMatch(/on (the pet's|its) file/);
    const es = await w.call(null, { clinic, channel: 'web' });
    es.caller('Hola, soy Ray Chen. Quiero una cita para mi perro Waffles.');
    const looked = await es.delegate([{ tool: 'verify_caller', args: { owner_name: 'Ray Chen', pet_name: 'Waffles', phone: null } }]);
    expect(looked.errors).toEqual(['phone_required']);
    expect(say(looked)).toContain('"¿Cuál es el mejor número para comunicarnos con usted?"');
  });
});

describe('a time chosen before the pet is found (2026-11)', () => {
  it('is kept through the registration, named for the planner, and read back only once proposed again', async () => {
    const c = await w.call('+17205550185', { clinic });
    c.caller('Is any vet free tomorrow after one, for a first check-up for my puppy?');
    const times = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_new', provider_id: null, from_date: '2026-09-29', from_time: '13:00', part_of_day: 'any' } }]);
    const slots = times.results[0]!.data.slots as { when: string; provider: string }[];
    c.caller("The second one. I'm Sam Ortega and he's Bolt, he's new.");
    const second = [...c.state.offered.values()][1]!;
    const early = await c.delegate([{ tool: 'propose_booking', args: { slot_id: second.id, replaces_appointment_id: null } }]);
    expect(early.errors).toEqual(['identity_required']);
    expect(say(early)).toContain(`The caller chose ${slots[1]!.when} with ${slots[1]!.provider}: that choice is kept`);
    expect(say(early)).toContain('never that it is done or taken care of');
    expect(c.state.chosen?.id).toBe(second.id);
    expect(c.state.pending).toBeNull();
    expect(stateLine(c.state, clinic)).toContain(`the caller chose ${slots[1]!.when} with ${slots[1]!.provider} before being found`);
    // nothing is staged yet: "I'll take care of it" is a promise nobody keeps
    expect(emptyPromise("Okay, I'll take care of it.", c.state)).toBe(true);
    expect(emptyPromise('Vale, yo me encargo.', c.state)).toBe(true);
    expect(emptyPromise('How old is Bolt?', c.state)).toBe(false);
    expect(emptyPromise('I\'ll book it as soon as I\'ve added Bolt. How old is he?', c.state)).toBe(false); // it says what it waits for
    expect(emptyPromise('Se lo reservo en cuanto registre a Bolt.', c.state)).toBe(false);

    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Bolt', owner_name: 'Sam Ortega', species: 'dog', sex: 'male', birthday_or_age: 'four months', phone: null } }]);
    expect(say(added)).toContain(`Before this, the caller chose ${slots[1]!.when} with ${slots[1]!.provider}. Look for it again now with find_slots (from_date 2026-09-29`);
    expect(say(added)).toContain('If it was taken meanwhile, say so and offer the times find_slots returns.');
    // looked for again, with the vet they chose: the same time comes back and is read back as a question
    await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_new', provider_id: second.providerId, from_date: '2026-09-29', from_time: added.results[0]!.data.say!.toString().match(/from_time (\d\d:\d\d)/)![1], part_of_day: 'any' } }]);
    expect(c.state.offered.has(second.id)).toBe(true);
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: second.id, replaces_appointment_id: null } }]);
    expect(c.state.pending?.kind === 'book' && c.state.pending.slot.id).toBe(second.id);
    expect(c.state.chosen).toBeNull();
    expect(emptyPromise("Okay, I'll take care of it.", c.state)).toBe(false); // something is waiting for the yes now
  });
});

describe('"still checking" once per wait (2026-11)', () => {
  it('drops an answer\'s "still checking" opening when the caller already heard it in this wait', async () => {
    const c = await w.call('+17205550172', { clinic });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let release!: () => void;
      const slow = { plan: () => new Promise<{ say: string }>((r) => { release = () => r({ say: "I'm still checking on that. Dr. Ruiz is free Tuesday at 9." }); }) };
      const notes: string[] = [];
      const pending = c.delegate([], slow, (o: Outbound) => { if (o.type === 'thinking') notes.push(o.content); });
      await vi.advanceTimersByTimeAsync(8000);
      expect(notes.filter((n) => n.includes('still checking'))).toHaveLength(1);
      release();
      const out = await pending;
      expect(out.flatMap((o) => (o.type === 'commentary' ? [o.content] : []))).toEqual(['Dr. Ruiz is free Tuesday at 9.']);
    } finally {
      vi.useRealTimers();
    }
  });
});
