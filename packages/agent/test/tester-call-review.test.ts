import { CallState } from '../src';
import { petFactNotSaid } from '../src/flow/pet-facts';
import { visitMeant } from '../src/flow/visit-pick';
import { describe, expect, it } from 'vitest';

// The reviewer's findings on PR1 (2026-11-26): made-up names only.
const call = (...turns: [('caller' | 'agent'), string][]) => {
  const s = new CallState();
  let t = 0;
  for (const [who, text] of turns) { s.addTranscript(who, text, t, t + 900); t += 1000; }
  return s;
};

describe('T1 review: the caller\'s own words, read as they say them', () => {
  it('T1-review: a birthday with an ordinal or a month name, and "a year and a half", are what the caller said', () => {
    expect(petFactNotSaid(call(['caller', 'She was born March 3rd 2023.']), { birthday_or_age: '2023-03-03' })).toBeNull();
    expect(petFactNotSaid(call(['caller', 'She was born March 3rd 2023.']), { birthday_or_age: 'March 3, 2023' })).toBeNull();
    expect(petFactNotSaid(call(['caller', "He's about a year and a half."]), { birthday_or_age: '1.5 years' })).toBeNull();
    expect(petFactNotSaid(call(['caller', 'Tiene año y medio.']), { birthday_or_age: '1.5 años' })).toBeNull();
    expect(petFactNotSaid(call(['caller', 'Nació el 3 de marzo de 2023.']), { birthday_or_age: '2023-03-03' })).toBeNull();
    // and still never a date or age they did not say
    expect(petFactNotSaid(call(['caller', 'She was born March 3rd 2023.']), { birthday_or_age: '2022-03-03' })).toBe('age');
    expect(petFactNotSaid(call(['caller', "He's about a year."]), { birthday_or_age: '1.5 years' })).toBe('age');
  });

  it('T1-review2: a date is checked as year, month and day: the wrong month, or a month and day never said, is asked for', () => {
    expect(petFactNotSaid(call(['caller', 'She was born May 3rd 2023.']), { birthday_or_age: '2023-03-03' })).toBe('age');
    expect(petFactNotSaid(call(['caller', 'She is 3. Born 2023.']), { birthday_or_age: '2023-03-03' })).toBe('age');
    expect(petFactNotSaid(call(['caller', 'Nació el 3 de mayo de 2023.']), { birthday_or_age: '2023-03-03' })).toBe('age');
    expect(petFactNotSaid(call(['caller', 'She was born on March 3rd.'], ['caller', 'In 2023.']), { birthday_or_age: '2023-03-03' })).toBeNull();
    expect(petFactNotSaid(call(['caller', 'Born 3/3/2023.']), { birthday_or_age: '2023-03-03' })).toBeNull();
    expect(petFactNotSaid(call(['caller', 'She was born in March 2023.']), { birthday_or_age: 'March 2023' })).toBeNull();
  });

  it('T1-review: a yes counts only for a question that named the value, never for a statement ("Got it, Tango is a cat." "Okay.")', () => {
    expect(petFactNotSaid(call(['agent', 'Got it, Tango is a cat.'], ['caller', 'Okay.']), { species: 'cat' })).toBe('species');
    expect(petFactNotSaid(call(['agent', 'Is Tango a cat?'], ['caller', 'Yes.']), { species: 'cat' })).toBeNull();
  });

  it('T1-review: "she" counts for the sex only when it is about the pet', () => {
    expect(petFactNotSaid(call(['caller', 'My neighbour said she can drive me. I have a new dog, Rex, two years old.']), { species: 'dog', sex: 'female' })).toBe('sex');
    expect(petFactNotSaid(call(['caller', "I have a new dog, Rex. She's two years old."]), { species: 'dog', sex: 'female' })).toBeNull();
    expect(petFactNotSaid(call(['caller', "She's a girl."]), { sex: 'female' })).toBeNull();
  });
});

describe('T3 review: "the other doctor", and a pet named like a vet', () => {
  const providers = [
    { id: 'prov_a', name: 'Dr. Bella Stone', kind: 'person' as const },
    { id: 'prov_b', name: 'Dr. Omar Reyes', kind: 'person' as const },
  ];
  const upcoming = [{ id: 'v_a', start: new Date('2026-10-01T15:00:00Z'), providerId: 'prov_a' }, { id: 'v_b', start: new Date('2026-10-02T16:00:00Z'), providerId: 'prov_b' }];
  const tz = 'America/Denver';
  const now = new Date('2026-09-28T16:00:00Z');
  const justBooked = (s: CallState) => { s.memory.visit = { appointmentId: 'v_b', start: upcoming[1]!.start, visitTypeId: 'vt_sick', providerId: 'prov_b' }; s.memory.visitAtTurn = 0; return s; };

  it('T3-review: "cancel the one with the other doctor" is the visit not with the vet just booked (EN and ES)', () => {
    expect(visitMeant(justBooked(call(['caller', 'Cancel the one with the other doctor.'])), upcoming, tz, now, providers)).toEqual({ id: 'v_a', why: 'named' });
    expect(visitMeant(justBooked(call(['caller', 'Cancele la cita con el otro doctor.'])), upcoming, tz, now, providers)).toEqual({ id: 'v_a', why: 'named' });
  });

  it('T3-review: a pet called Bella is the pet, not Dr. Bella Stone, unless the caller says "Dr. Bella"', () => {
    const s = justBooked(call(['caller', 'Cancel the visit for Bella.']));
    s.memory.pets = ['Bella', 'Pico'];
    expect(visitMeant(s, upcoming, tz, now, providers)?.id).not.toBe('v_a');
    const t = justBooked(call(['caller', 'Cancel the one with Dr. Bella.']));
    t.memory.pets = ['Bella', 'Pico'];
    expect(visitMeant(t, upcoming, tz, now, providers)).toEqual({ id: 'v_a', why: 'named' });
  });
});
