import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callStateNote, slotArgsAsMeant } from '../src';
import { world } from './support';

// A tester's 14-minute call on the demo clinic (2026-11-24), the high items, at the agent: made-up names and numbers.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = {
  ...RIVERBEND_CLINIC, afterHours: 'book' as const,
  providers: RIVERBEND_CLINIC.providers.map((p) => (p.id === 'prov_ruiz' ? { ...p, credentials: ['DVM'] } : p.id === 'prov_sato' ? { ...p, credentials: ['DVM', 'Board-certified in exotic animal care'] } : p)),
};
const said = (out: { results: { data: Record<string, unknown> }[] }) => out.results.map((r) => `${String(r.data.spoken ?? '')} ${String(r.data.say ?? '')}`).join(' ');
const questions = (text: string) => (text.match(/\?/g) ?? []).length;

describe('T6: the vets, answered once', () => {
  it('T6: "what other doctors do you have, and their qualifications?" gets every vet with specialty and qualifications, never "I don\'t have that"', async () => {
    const c = await w.call('+13035550171', { clinic });
    c.caller('What other doctors do you have, and what are their qualifications?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'What other doctors do you have, and what are their qualifications?' } }]);
    const spoken = String(out.results[0]!.data.spoken ?? '');
    for (const part of ['Dr. Elena Ruiz', 'Dr. Marcus Bell', 'Dr. Hana Sato', 'General practice', 'Exotic pets', 'DVM', 'Board-certified in exotic animal care']) expect(spoken.toLowerCase()).toContain(part.toLowerCase());
    expect(said(out)).not.toContain("I don't have that information");
  });

  it('T6: in Spanish too', async () => {
    const c = await w.call('+13035550171', { clinic });
    c.caller('¿Qué otros doctores tienen y qué títulos tienen?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: '¿Qué otros doctores tienen y qué títulos tienen?' } }]);
    const spoken = String(out.results[0]!.data.spoken ?? '');
    for (const part of ['Dra. Elena Ruiz', 'Dr. Marcus Bell', 'Dra. Hana Sato', 'DVM']) expect(spoken).toContain(part);
  });
});

describe('T7: the household stays in the call', () => {
  it('T7: after a pet is added, another visit is "For Tango or another pet?", never the number again', async () => {
    const c = await w.call('+13035550172', { clinic });
    c.caller("Hi, I'm Corin Vale. I want to register my new cat Tango, she's two years old.");
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Tango', owner_name: 'Corin Vale', species: 'cat', sex: 'female', birthday_or_age: 'two years', phone: null } }]);
    expect(added.errors).toEqual([null]);
    expect(callStateNote(c.state)).toContain('For Tango or another pet?');
    c.assistant('Tango is registered. Anything else?');
    c.caller('Can you make another appointment?');
    const again = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: null, phone: null } }]);
    expect(said(again)).toContain('For Tango or another pet?');
    expect(said(again)).not.toMatch(/profile under|What phone number/);
    // two more pets added, then back to the first: opened again, never "too many tries"
    for (const [pet, kind, words] of [['Pico', 'dog', 'Pico is a dog, a boy, one year old.'], ['Juno', 'rabbit', "Juno is a rabbit, she's six months old."]] as const) {
      c.caller(words);
      const more = await c.delegate([{ tool: 'register_patient', args: { pet_name: pet, owner_name: null, species: kind, sex: pet === 'Pico' ? 'male' : 'female', birthday_or_age: pet === 'Pico' ? 'one year' : 'six months', phone: null } }]);
      expect(more.errors, pet).toEqual([null]);
      c.assistant(`${pet} is registered.`);
    }
    c.caller("Now back to Tango's visits.");
    const back = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Tango', phone: null } }]);
    expect(back.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.firstName).toBe('Tango');
  });
});

describe('T8: a visit moved from one pet to another', () => {
  it('T8: "move Biscuit\'s visit to Mochi" is one read-back, one yes, one text: Biscuit\'s visit is cancelled and Mochi has the same time', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen, for Biscuit. Can he come in tomorrow?');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }]);
    const found = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: 'prov_bell', from_date: '2026-10-01', part_of_day: 'any' } }]);
    c.caller('The first one.');
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: (found.results[0]!.data.slots as { slot_id: string }[])[0]!.slot_id, replaces_appointment_id: null } }]);
    c.readBack('Shall I book it?');
    c.caller('Yes.');
    await c.delegate([{ tool: 'commit_pending', args: {} }]);
    const biscuit = c.state.verifiedPatient!.id;
    const [visit] = await w.backend.scheduler.upcoming(clinic.id, biscuit, new Date('2026-10-01T00:00:00Z'));
    const texts = w.sms.length;
    c.caller('Actually, can you give that slot to Mochi instead?');
    const proposed = await c.delegate([{ tool: 'move_visit_to_pet', args: { appointment_id: visit!.id, pet_name: 'Mochi' } }]);
    expect(proposed.errors).toEqual([null]);
    expect(c.state.pending?.readback).toMatch(/from Biscuit to Mochi/);
    c.readBack('Shall I?');
    c.caller('Yes, please.');
    const done = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(done.errors).toEqual([null]);
    expect(await w.backend.scheduler.upcoming(clinic.id, biscuit, new Date('2026-10-01T00:00:00Z'))).toEqual([]);
    const mochi = c.state.verifiedPatient!;
    expect(mochi.firstName).toBe('Mochi');
    const moved = await w.backend.scheduler.upcoming(clinic.id, mochi.id, new Date('2026-10-01T00:00:00Z'));
    expect(moved.map((a) => a.start.getTime())).toEqual([visit!.start.getTime()]);
    expect(w.sms.length - texts).toBe(1);
  });
});

describe('T10: one registration question at a time', () => {
  it('T10: a new pet asks one thing at a time, in the backend\'s words, never the whole list', async () => {
    const c = await w.call('+13035550173', { clinic });
    c.caller("Hi, I'm Corin Vale. I want to register my new dog Pixel.");
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Corin Vale', pet_name: 'Pixel', phone: null } }]);
    expect(out.errors).toEqual(['pet_is_new']);
    expect(questions(said(out))).toBe(1);
    expect(said(out)).not.toMatch(/the kind of animal, its sex/);
    expect(said(out)).toContain('Is Pixel a boy or a girl?');
    c.caller("He's a boy.");
    const next = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Pixel', owner_name: 'Corin Vale', species: 'dog', sex: 'male', birthday_or_age: null, phone: null } }]);
    expect(next.errors).toEqual(['unclear_age']);
    expect(said(next)).toContain('How old is Pixel, roughly?');
    expect(questions(said(next))).toBe(1);
  });
});

describe('T11: a fragment in another language is confirmed before it is used', () => {
  it('T11: "Es Kelly." on an English call is asked back ("Kelly is the pet\'s name, right?") before the pet is added', async () => {
    const c = await w.call('+13035550174', { clinic });
    c.caller("Hi, I'm Corin Vale. I'd like to add a new dog, a girl, about one year old.");
    c.assistant("What is your dog's name?");
    c.caller('Es Kelly.');
    const out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Kelly', owner_name: 'Corin Vale', species: 'dog', sex: 'female', birthday_or_age: 'about one year', phone: null } }]);
    expect(out.errors).toEqual(['confirm_pet_name']);
    expect(said(out)).toContain("Kelly is the pet's name, right?");
    expect(c.state.verifiedPatient).toBeNull();
    c.caller('Yes.');
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Kelly', owner_name: 'Corin Vale', species: 'dog', sex: 'female', birthday_or_age: 'about one year', phone: null } }]);
    expect(added.errors).toEqual([null]);
  });

  it('T11: a name said in a sentence of the call\'s own language is used at once', async () => {
    const c = await w.call('+13035550175', { clinic });
    c.caller("Hi, I'm Corin Vale. I'd like to add my new dog Kelly, she's about one year old.");
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Kelly', owner_name: 'Corin Vale', species: 'dog', sex: 'female', birthday_or_age: 'about one year', phone: null } }]);
    expect(added.errors).toEqual([null]);
  });
});

describe('T12: find_slots takes the argument shapes voice models send', () => {
  const shapes: Record<string, unknown>[] = [];
  const provider = [undefined, null, 'any', 'none', '', 'prov_ruiz', 'Dr. Ruiz', 'Elena Ruiz', 'ruiz'];
  const date = [undefined, null, 'any', '', '2026-10-01', '2026-10-01T09:00:00', 'tomorrow', 'today', 'Thursday', 'next Thursday', 'October 1', '10/01/2026', 'mañana', 'el jueves'];
  const part = [undefined, null, 'any', 'morning', 'Afternoon', 'evening', ''];
  const time = [undefined, null, '', '15:00', '3pm', '3:30 PM', '15:00:00', 'noon', 'after 3'];
  // every value of each argument at least once, with the others varied, as a property check
  const n = Math.max(provider.length, date.length, part.length, time.length) * 3;
  for (let i = 0; i < n; i++) {
    const s: Record<string, unknown> = { visit_type_id: 'vt_sick' };
    const put = (k: string, v: unknown) => { if (v !== undefined) s[k] = v; };
    put('provider_id', provider[i % provider.length]);
    put('from_date', date[(i * 5) % date.length]);
    put('part_of_day', part[(i * 3) % part.length]);
    put('from_time', time[(i * 7) % time.length]);
    shapes.push(s);
  }

  it('T12: none of the shapes is invalid_arguments, and the vet named instead of an id is that vet', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen, for Biscuit.');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }]);
    const bad: string[] = [];
    for (const s of shapes) {
      const out = await c.delegate([{ tool: 'find_slots', args: s }]);
      if (out.errors[0] === 'invalid_arguments') bad.push(`${JSON.stringify(s)} -> ${JSON.stringify(out.results[0]!.data.invalid_fields)}`);
    }
    expect(bad).toEqual([]);
    expect((slotArgsAsMeant({ visit_type_id: 'vt_sick', provider_id: 'Dr. Ruiz' }, clinic) as { provider_id: unknown }).provider_id).toBe('prov_ruiz');
    expect((slotArgsAsMeant({ visit_type_id: 'vt_sick', from_date: 'tomorrow' }, clinic, new Date('2026-09-28T16:00:00Z')) as { from_date: unknown }).from_date).toBe('2026-09-29');
  });
});

describe('T13: a pet added on the calling number makes the call verified', () => {
  it('T13: register_patient under caller ID is a verified caller, as the calls list reads it', async () => {
    const c = await w.call('+13035550176', { clinic });
    c.caller("Hi, I'm Corin Vale. I want to register my new cat Tango, she's two years old.");
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Tango', owner_name: 'Corin Vale', species: 'cat', sex: 'female', birthday_or_age: 'two years', phone: null } }]);
    expect(added.results[0]!.data).toMatchObject({ registered: true, verified: true });
  });
});
