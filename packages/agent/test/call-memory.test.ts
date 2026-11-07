import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallMemory, CallState, fillFromMemory, memoryLine } from '../src';
import { stateLine } from '../src/planner';
import { world } from './support';

// one call memory: a fact the caller said once is passed, never asked again (2026-11-14)
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const opts = { industry: 'vet', verifiedPatient: false, callerNumber: null };

describe('the call memory', () => {
  it('keeps what the caller says, and a correction replaces it', () => {
    const m = new CallMemory();
    m.fromCaller("Hi, my dog needs a check-up, she's two years old", 'en', clinic, '2026-09-28', 0);
    expect([m.get('species'), m.get('sex'), m.get('age'), m.get('intent')]).toEqual(['dog', 'female', '2 years', 'book']);
    m.fromCaller('No, sorry, it\'s a cat', 'en', clinic, '2026-09-28', 2);
    expect(m.get('species')).toBe('cat');
    expect(m.fact('species')).toMatchObject({ source: 'caller', atTurn: 2 });
  });

  it('keeps what the tools were given', () => {
    const m = new CallMemory();
    m.fromToolArgs('register_patient', { pet_name: 'Pepper', owner_name: 'Jordan', species: 'Rabbit', sex: 'female', birthday_or_age: '3 years', phone: '303-555-0142' }, clinic, null, 1);
    expect([m.get('petName'), m.get('saidName'), m.get('species'), m.get('number')]).toEqual(['Pepper', 'Jordan', 'rabbit', { digits: '13035550142', readBack: false, callerId: false }]);
    m.fromToolArgs('find_slots', { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-10-01', from_time: '15:00' }, clinic, null, 2);
    expect([m.get('visitType'), m.get('day'), m.get('time')]).toEqual(['vt_wellness', { date: '2026-10-01' }, { time: '15:00', mode: 'after' }]);
  });

  it('fills an argument the planner left null, and never one it passed', () => {
    const m = new CallMemory();
    m.fromCaller('my dog, a female, about 2 years old. Thursday at 5 please', 'en', clinic, '2026-09-28', 0);
    const reg = fillFromMemory('register_patient', { pet_name: 'Rex', owner_name: 'Jordan', species: null, sex: null, birthday_or_age: null, phone: null }, m, opts);
    expect(reg.args).toMatchObject({ species: 'dog', sex: 'female', birthday_or_age: '2 years' });
    expect(reg.filled).toEqual(['species', 'sex', 'birthday_or_age']);
    const kept = fillFromMemory('register_patient', { pet_name: 'Rex', owner_name: 'Jordan', species: 'cat', sex: 'male', birthday_or_age: '5 years', phone: null }, m, opts);
    expect(kept.filled).toEqual([]);
    expect(kept.args).toMatchObject({ species: 'cat', sex: 'male', birthday_or_age: '5 years' });
    const slots = fillFromMemory('find_slots', { visit_type_id: 'vt_wellness', provider_id: null, from_date: null, part_of_day: 'any', from_time: null }, m, opts);
    expect(slots.args).toMatchObject({ from_date: '2026-10-01', from_time: '17:00' });
  });

  it('never fills a pet\'s name or a day the caller called "any"', () => {
    const m = new CallMemory();
    m.set('petName', 'Biscuit', 'tool');
    expect(fillFromMemory('verify_caller', { owner_name: null, pet_name: null, phone: null, species: null }, m, opts).filled).toEqual([]);
    m.fromCaller('Thursday... actually the first available is fine', 'en', clinic, '2026-09-28', 0);
    expect(fillFromMemory('find_slots', { visit_type_id: 'vt_wellness', provider_id: null, from_date: null, part_of_day: 'any' }, m, opts).filled).toEqual([]);
  });

  it('a move after a booking on the call replaces that visit', () => {
    const m = new CallMemory();
    m.visit = { appointmentId: 'appt-1', start: new Date('2026-09-30T23:20:00Z'), visitTypeId: 'vt_wellness', providerId: 'prov_ruiz' };
    m.set('intent', 'move', 'caller');
    expect(fillFromMemory('propose_booking', { slot_id: 's', replaces_appointment_id: null }, m, opts).args).toMatchObject({ replaces_appointment_id: 'appt-1' });
    m.set('intent', 'book', 'caller');
    expect(fillFromMemory('propose_booking', { slot_id: 's', replaces_appointment_id: null }, m, opts).filled).toEqual([]);
  });

  it('never says the owner on file before the caller is verified', () => {
    const m = new CallMemory();
    m.owner = 'Jordan';
    m.set('saidName', 'Alex', 'tool');
    expect(memoryLine(m, clinic)).not.toContain('Jordan');
    expect(memoryLine(m, clinic)).toContain('the caller said their name is Alex');
    m.verified = 'caller_id';
    expect(memoryLine(m, clinic)).toContain('owner Jordan');
  });

  it('stays short for a full call, in the per-turn state line', () => {
    const s = new CallState();
    s.memory.set('number', { digits: '13035550142', readBack: true, callerId: false }, 'tool');
    s.memory.verified = 'name_match';
    s.memory.owner = 'Jordan';
    s.memory.pets = ['Biscuit', 'Pepper', 'Mochi'];
    s.memory.fromCaller('a new female dog, 2 years old, book a check-up on Wednesday at 5 with Dr. Ruiz', 'en', clinic, '2026-09-28', 0);
    s.memory.set('visitType', 'vt_wellness', 'tool');
    s.memory.visit = { appointmentId: 'a', start: new Date('2026-09-30T23:20:00Z'), visitTypeId: 'vt_wellness', providerId: 'prov_ruiz' };
    const line = memoryLine(s.memory, clinic)!;
    expect(line.length).toBeLessThan(600);
    expect(line).toContain('number ending 0142 (read back, yes)');
    expect(line).toContain('pets on this number: Biscuit, Pepper, Mochi');
    expect(line).toContain('wants: book a wellness exam, Wednesday, September 30, around 17:00, with Dr.');
    expect(stateLine(s, clinic)).toContain(line);
  });
});

describe('on a call', () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
  afterAll(() => w.t.close());

  it('a new pet: the kind of animal said first is never asked for', async () => {
    const c = await w.call('+17205550181', { clinic });
    c.caller("Hi, my dog needs a check-up. She's new, she's a female, about a year old.");
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Pixel', owner_name: 'Nora', species: null, sex: null, birthday_or_age: null, phone: null } }]);
    expect(added.errors).toEqual([null]);
    expect(added.results[0]!.data).toMatchObject({ registered: true, filled_from_memory: ['species', 'sex', 'birthday_or_age'] });
    expect(c.state.verifiedPatient).toMatchObject({ firstName: 'Pixel', species: 'dog' });
  });

  it('asks only for what is still missing, naming it', async () => {
    const c = await w.call('+17205550182', { clinic });
    c.caller("I'd like to add my new pet Rocket, he's new.");
    const asked = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Rocket', owner_name: 'Sam', species: null, sex: null, birthday_or_age: null, phone: null } }]);
    expect(asked.errors).toEqual(['pet_species']);
    c.caller("He's a rabbit, a boy, three years old.");
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Rocket', owner_name: 'Sam', species: null, sex: null, birthday_or_age: null, phone: null } }]);
    expect(added.errors).toEqual([null]);
    expect(c.state.verifiedPatient).toMatchObject({ firstName: 'Rocket', species: 'rabbit' });
  });
});


describe('the caller\'s day, from the clinic clock (batch 1c)', () => {
  it('"Thursday" on Monday, September 28 is October 1: a Thursday the model dated in another week is corrected; another day it chose is kept', () => {
    const m = new CallMemory();
    m.fromCaller('Could Biscuit see Dr. Khan around 5 on Thursday? Biscuit is sick.', 'en', clinic, '2026-09-28', 0);
    const wrongWeek = fillFromMemory('find_slots', { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-11-12', part_of_day: 'any', from_time: '17:00' }, m, opts);
    expect((wrongWeek.args as { from_date: string }).from_date).toBe('2026-10-01');
    expect(wrongWeek.filled).toContain('from_date');
    // Friday, a day the tool offered and the caller took without naming it: not the caller's Thursday, so kept
    const otherDay = fillFromMemory('find_slots', { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-10-02', part_of_day: 'any', from_time: '17:00' }, m, opts);
    expect((otherDay.args as { from_date: string }).from_date).toBe('2026-10-02');
    // Spanish: "el viernes" on the same Monday is October 2
    const es = new CallMemory();
    es.fromCaller('¿Puede ver la doctora Vance a Biscuit el viernes a las 5:30 de la tarde?', 'es', clinic, '2026-09-28', 0);
    expect((fillFromMemory('find_slots', { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-11-06', part_of_day: 'any', from_time: '17:30' }, es, opts).args as { from_date: string }).from_date).toBe('2026-10-02');
  });

  it('a weekday with a holiday, a date or a week count is the caller\'s own: "the Friday after Thanksgiving" is never pulled to next Friday', () => {
    for (const said of ['Can we do the Friday after Thanksgiving?', 'Friday the 27th, please.', 'Not this Friday, the Friday after next.', 'el viernes 27 de noviembre']) {
      const m = new CallMemory();
      m.fromCaller(said, said.startsWith('el ') ? 'es' : 'en', clinic, '2026-09-28', 0);
      const out = fillFromMemory('find_slots', { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-11-27', part_of_day: 'any', from_time: null }, m, opts);
      expect((out.args as { from_date: string }).from_date).toBe('2026-11-27');
    }
  });
});
