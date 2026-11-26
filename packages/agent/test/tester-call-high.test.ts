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
  it('T11: "Es Sunny." on an English call is asked back ("Sunny is the pet\'s name, right?") before the pet is added', async () => {
    const c = await w.call('+13035550174', { clinic });
    c.caller("Hi, I'm Corin Vale. I'd like to add a new dog, a girl, about one year old.");
    c.assistant("What is your dog's name?");
    c.caller('Es Sunny.');
    const out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Sunny', owner_name: 'Corin Vale', species: 'dog', sex: 'female', birthday_or_age: 'about one year', phone: null } }]);
    expect(out.errors).toEqual(['confirm_pet_name']);
    expect(said(out)).toContain("Sunny is the pet's name, right?");
    expect(c.state.verifiedPatient).toBeNull();
    c.caller('Yes.');
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Sunny', owner_name: 'Corin Vale', species: 'dog', sex: 'female', birthday_or_age: 'about one year', phone: null } }]);
    expect(added.errors).toEqual([null]);
  });

  it('T11: a name said in a sentence of the call\'s own language is used at once', async () => {
    const c = await w.call('+13035550175', { clinic });
    c.caller("Hi, I'm Corin Vale. I'd like to add my new dog Sunny, she's about one year old.");
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Sunny', owner_name: 'Corin Vale', species: 'dog', sex: 'female', birthday_or_age: 'about one year', phone: null } }]);
    expect(added.errors).toEqual([null]);
  });
});

describe('T12: find_slots takes the argument shapes voice models send', () => {
  const shapes: Record<string, unknown>[] = [];
  const provider = [undefined, null, 'any', 'none', '', 'prov_ruiz', 'Dr. Ruiz', 'Elena Ruiz', 'ruiz'];
  const date = [undefined, null, 'any', '', '2026-10-01', '2026-10-01T09:00:00', 'tomorrow', 'today', 'Thursday', 'next Thursday', 'October 1', '10/01/2026', 'mañana', 'el jueves',
    // a day with a part of day or a time in the same words (the owner's live rerun, 2026-11-26: "tomorrow morning")
    'tomorrow morning', 'tomorrow afternoon', 'Friday morning', 'next Tuesday at 3', 'this evening', 'mañana por la mañana', 'el viernes por la tarde', 'pasado mañana'];
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

describe('T12-live: a day said with a part of day or a time is read as both', () => {
  const now = new Date('2026-09-28T16:00:00Z');
  const meant = (from_date: string, part_of_day: unknown = null) => slotArgsAsMeant({ visit_type_id: 'vt_sick', provider_id: null, from_date, part_of_day }, clinic, now) as Record<string, unknown>;
  const day = (words: string) => meant(words).from_date;

  it('T12-live: the date part is taken, and part_of_day filled from the words when it was left out (EN/ES)', () => {
    expect(meant('tomorrow morning')).toMatchObject({ from_date: '2026-09-29', part_of_day: 'morning' });
    expect(meant('tomorrow afternoon')).toMatchObject({ from_date: '2026-09-29', part_of_day: 'afternoon' });
    expect(meant('Friday morning')).toMatchObject({ from_date: day('Friday'), part_of_day: 'morning' });
    expect(meant('next Tuesday at 3')).toMatchObject({ from_date: day('next Tuesday'), from_time: '15:00', time_mode: 'at' });
    expect(meant('this evening')).toMatchObject({ from_date: '2026-09-28', part_of_day: 'afternoon' });
    expect(meant('mañana por la mañana')).toMatchObject({ from_date: '2026-09-29', part_of_day: 'morning' });
    expect(meant('el viernes por la tarde')).toMatchObject({ from_date: day('el viernes'), part_of_day: 'afternoon' });
    expect(meant('pasado mañana')).toMatchObject({ from_date: '2026-09-30', part_of_day: 'any' });
    expect(meant('tomorrow morning', 'any')).toMatchObject({ from_date: '2026-09-29', part_of_day: 'morning' });
    // a part of day the model gave is kept
    expect(meant('tomorrow morning', 'afternoon')).toMatchObject({ from_date: '2026-09-29', part_of_day: 'afternoon' });
  });

  it('T12-live: from_date "tomorrow morning" with part_of_day "morning" (the live call) finds tomorrow morning, never invalid_arguments', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen. Can Biscuit come in tomorrow morning for a sick visit?');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }]);
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, provider_gender: null, specialty: null, from_date: 'tomorrow morning', part_of_day: 'morning', from_time: null, time_mode: 'earliest', propose_if_exact: null } }]);
    expect(out.errors).toEqual([null]);
    expect(JSON.stringify(out.results[0]!.data.slots)).toContain('September 29');
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

describe('T8: a visit moved to another pet keeps to the vets who see that animal (K1)', () => {
  it('T8: moving a visit with a dogs-and-cats vet to a rabbit is refused plainly, with the vet who sees rabbits offered', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller("Hi, Linh Nguyen. I want to add my new rabbit Clover, she's one year old.");
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Clover', owner_name: 'Linh Nguyen', species: 'rabbit', sex: 'female', birthday_or_age: 'one year', phone: null } }]);
    expect(added.errors).toEqual([null]);
    c.assistant('Clover is registered.');
    c.caller('And Biscuit, can he see Dr. Bell on Friday?');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }]);
    const found = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: 'prov_bell', from_date: '2026-10-02', part_of_day: 'any' } }]);
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: (found.results[0]!.data.slots as { slot_id: string }[])[0]!.slot_id, replaces_appointment_id: null } }]);
    c.readBack('Shall I book it?');
    c.caller('Yes.');
    expect((await c.delegate([{ tool: 'commit_pending', args: {} }])).errors).toEqual([null]);
    const [visit] = await w.backend.scheduler.upcoming(clinic.id, c.state.verifiedPatient!.id, new Date('2026-10-02T00:00:00Z'));
    c.caller('Actually, give that visit to Clover.');
    const out = await c.delegate([{ tool: 'move_visit_to_pet', args: { appointment_id: visit!.id, pet_name: 'Clover' } }]);
    expect(out.errors).toEqual(['vet_not_for_animal']);
    expect(said(out)).toContain('Dr. Marcus Bell');
    expect(said(out)).toContain('Dr. Hana Sato');
    expect(c.state.pending).toBeNull();
  });
});

describe('PR2 review', () => {
  it('T6-review: the vets\' list only for who the vets are; an address, the hours or a price keep the clinic\'s own answer', async () => {
    for (const q of ["What is the vet's address?", '¿A qué hora abre el veterinario?', 'What do the vets charge for a dental?']) {
      const c = await w.call('+13035550171', { clinic });
      c.caller(q);
      const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: q } }]);
      expect(String(out.results[0]!.data.spoken ?? ''), q).not.toContain('Dr. Marcus Bell');
    }
    const c = await w.call('+13035550171', { clinic });
    c.caller("What is the vet's address?");
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: "What is the vet's address?" } }]);
    expect(out.results[0]!.data.source).toBe('faq_address');
  });

  it('T6-review: in Spanish the specialty is said in Spanish', async () => {
    const c = await w.call('+13035550171', { clinic });
    c.caller('¿Quiénes son sus veterinarios?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: '¿Quiénes son sus veterinarios?' } }]);
    const spoken = String(out.results[0]!.data.spoken ?? '');
    expect(spoken).toContain('medicina general');
    expect(spoken).toContain('animales exóticos');
    expect(spoken).not.toMatch(/general practice|exotic pets/i);
  });

  it('T8-review: the visit moves in one step: if the other pet cannot have it, the first pet keeps it, and the caller hears the truth', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen, for Biscuit.');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }]);
    // Mochi already has a visit at that time, so the move can't go through
    const found = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: 'prov_ruiz', from_date: '2026-10-13', part_of_day: 'any' } }]);
    const slot = (found.results[0]!.data.slots as { slot_id: string }[])[0]!.slot_id;
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: slot, replaces_appointment_id: null } }]);
    c.readBack('Shall I book it?');
    c.caller('Yes.');
    await c.delegate([{ tool: 'commit_pending', args: {} }]);
    const biscuit = c.state.verifiedPatient!.id;
    const [visit] = await w.backend.scheduler.upcoming(clinic.id, biscuit, new Date('2026-10-13T00:00:00Z'));
    await w.backend.scheduler.book(clinic.id, { patientId: w.patientIds.mochi!, callId: c.callId, idempotencyKey: 'mochi-busy', slot: { id: 'x', providerId: 'prov_bell', visitTypeId: 'vt_sick', start: visit!.start, end: new Date(visit!.start.getTime() + 20 * 60_000) } });
    c.caller('Give that visit to Mochi instead.');
    await c.delegate([{ tool: 'move_visit_to_pet', args: { appointment_id: visit!.id, pet_name: 'Mochi' } }]);
    c.readBack('Shall I?');
    c.caller('Yes.');
    const done = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(done.errors[0]).toMatch(/patient_busy|swap_failed/);
    const still = await w.backend.scheduler.upcoming(clinic.id, biscuit, new Date('2026-10-13T00:00:00Z'));
    expect(still.map((a) => a.id)).toEqual([visit!.id]); // the very same visit, never cancelled and booked again
  });

  it('T12-review: an impossible date ("February 30", "02/30/2027", "June 31") is never moved to another day', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, Linh Nguyen, for Biscuit.');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit' } }]);
    for (const d of ['February 30', '02/30/2027', 'June 31', '31 de junio']) {
      expect((slotArgsAsMeant({ visit_type_id: 'vt_sick', from_date: d }, clinic, new Date('2026-09-28T16:00:00Z')) as { from_date: unknown }).from_date, d).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: d, part_of_day: 'any' } }]);
      expect(out.errors[0], d).toBe('invalid_date');
      expect(String(out.results[0]!.data.say), d).toMatch(/isn't a date|no es una fecha/);
    }
  });

  it('T13-review: a pet added under a number the caller said (not the one calling) does not mark the call verified', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller("I'm Corin Vale, my new cat Tango is two years old, she's a girl. The number is 303 555 0179.");
    let out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Tango', owner_name: 'Corin Vale', species: 'cat', sex: 'female', birthday_or_age: 'two years', phone: '303 555 0179' } }]);
    for (let i = 0; i < 3 && out.errors[0] !== null; i++) {
      if (out.errors[0] === 'confirm_number') { c.assistant("That's 3 0 3, 5 5 5, 0 1 7 9?"); c.caller('Yes.'); }
      out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Tango', owner_name: 'Corin Vale', species: 'cat', sex: 'female', birthday_or_age: 'two years', phone: '303 555 0179' } }]);
    }
    expect(out.results[0]!.data.registered).toBe(true);
    expect(out.results[0]!.data.verified).toBeUndefined();
  });
});

describe('PR2 review 2', () => {
  it('T6-review2: "Who is the vet on Friday?" names only the vets in that day, never the whole list', async () => {
    const day = { ...clinic, providers: clinic.providers.map((p) => (p.id === 'prov_bell' ? { ...p, timeOff: [{ from: '2026-10-02', to: '2026-10-02' }] } : p)) };
    const c = await w.call('+13035550171', { clinic: day });
    c.caller('Who is the vet on Friday?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'Who is the vet on Friday?' } }]);
    const spoken = String(out.results[0]!.data.spoken ?? '');
    expect(spoken).toContain('Dr. Elena Ruiz');
    expect(spoken).not.toContain('Dr. Marcus Bell'); // away that Friday
    expect(spoken).not.toContain('Dr. Hana Sato'); // works Tuesdays and Thursdays only
  });

  it('T6-review2: "Who are your doctors and where did they train?" is about the vets: their qualifications are answered (EN and ES)', async () => {
    for (const q of ['Who are your doctors and where did they train?', '¿Quiénes son sus doctores y dónde estudiaron?']) {
      const c = await w.call('+13035550171', { clinic });
      c.caller(q);
      const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: q } }]);
      expect(String(out.results[0]!.data.spoken ?? ''), q).toContain('DVM');
    }
  });
});

describe('PR2 review 3', () => {
  it('T6-review3: "Which vets are in on October 2?" names only the vets in that day', async () => {
    const day = { ...clinic, providers: clinic.providers.map((p) => (p.id === 'prov_bell' ? { ...p, timeOff: [{ from: '2026-10-02', to: '2026-10-02' }] } : p)) };
    const c = await w.call('+13035550171', { clinic: day });
    c.caller('Which vets are in on October 2?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'Which vets are in on October 2?' } }]);
    const spoken = String(out.results[0]!.data.spoken ?? '');
    expect(spoken).toContain('Dr. Elena Ruiz');
    expect(spoken).not.toContain('Dr. Marcus Bell');
    expect(spoken).not.toContain('Dr. Hana Sato');
  });

  it('T6-review3: "Where did your vets go to school?" and "Who are your doctors and where did they train?" get one answer: the vets\' qualifications, never the address', async () => {
    for (const q of ['Where did your vets go to school?', 'Who are your doctors and where did they train?', '¿Dónde estudiaron sus veterinarios?']) {
      const c = await w.call('+13035550171', { clinic });
      c.caller(q);
      const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: q } }]);
      const data = out.results[0]!.data;
      expect(String(data.spoken ?? ''), q).toContain('DVM');
      expect(data.answer ?? null, q).toBeNull();
      expect(JSON.stringify(data), q).not.toContain('88 Riverbend Road, Denver, with free parking');
    }
  });
});

describe('PR2 review 4', () => {
  it('T6-review4: "Who is the vet on 10/02?" names only the vets in that day', async () => {
    const day = { ...clinic, providers: clinic.providers.map((p) => (p.id === 'prov_bell' ? { ...p, timeOff: [{ from: '2026-10-02', to: '2026-10-02' }] } : p)) };
    const c = await w.call('+13035550171', { clinic: day });
    c.caller('Who is the vet on 10/02?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'Who is the vet on 10/02?' } }]);
    const spoken = String(out.results[0]!.data.spoken ?? '');
    expect(spoken).toContain('Dr. Elena Ruiz');
    expect(spoken).not.toContain('Dr. Marcus Bell');
  });

  it('T6-review4: "Do your vets do training classes for puppies?" is no question about their qualifications', async () => {
    const c = await w.call('+13035550171', { clinic });
    c.caller('Do your vets do training classes for puppies?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'Do your vets do training classes for puppies?' } }]);
    expect(String(out.results[0]!.data.spoken ?? '')).not.toContain('Our vets are');
  });
});
