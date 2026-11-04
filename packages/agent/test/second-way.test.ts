// SPDX-License-Identifier: AGPL-3.0-only
import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// A second way to find the profile (2026-11-15): a number said with its country prefix was read back three times and
// the call gave up. The prefix is dropped; after two read-backs the caller says are wrong, or a number with no profile,
// the last four digits of the number on file and the pet's name, accepted only when exactly one household matches.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const said = (out: { results: { data: Record<string, unknown> }[] }) => JSON.stringify(out.results.map((r) => r.data));
const verify = (phone: string | null, pet: string | null = null, last4: string | null = null) => ({ tool: 'verify_caller', args: { owner_name: null, pet_name: pet, phone, phone_last4: last4 } }) as const;

describe('a spoken country prefix', () => {
  it('is dropped before the read-back, and the number found', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    const out = await c.delegate([verify('52 720 555 0174', 'Luna')]);
    expect(out.errors).toEqual(['confirm_number']);
    expect(said(out)).toContain("That's 720-555-0174?");
    c.assistant("That's 720-555-0174?");
    c.caller('Yes.');
    const named = await c.delegate([verify('52 720 555 0174', 'Luna')]);
    expect(named.errors).toEqual(['owner_check']);
    c.assistant('And your name?');
    c.caller('Carmen.');
    const found = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Carmen', pet_name: 'Luna', phone: '52 720 555 0174', phone_last4: null } }]);
    expect(found.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.firstName).toBe('Luna');
  });
});

describe('after two wrong read-backs', () => {
  it('asks for the last four digits and the pet\'s name, and finds the one pet', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    await c.delegate([verify('720 555 0177', 'Luna')]);
    c.assistant("That's 720-555-0177?");
    c.caller('No, it is 720 555 0178.');
    const second = await c.delegate([verify('720 555 0178', 'Luna')]);
    expect(second.errors).toEqual(['confirm_number']);
    c.assistant("That's 720-555-0178?");
    c.caller('No, sorry.');
    const third = await c.delegate([verify('720 555 0179', 'Luna')]);
    expect(third.errors).toEqual(['ask_last_four']);
    expect(said(third)).toContain("Let's try another way. What are the last four digits of the number the profile is under, and your pet's name?");
    expect(c.state.readbacksWrong).toBe(2);
    c.assistant("Let's try another way. What are the last four digits of the number the profile is under, and your pet's name?");
    c.caller('Zero one seven four, and she is Luna.');
    const found = await c.delegate([verify(null, 'Luna', 'zero one seven four')]);
    expect(found.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.firstName).toBe('Luna');
    // the record opens nothing more: never the number on file or the owner's name
    expect(said(found)).toContain('I found Luna, your dog.');
    expect(said(found)).not.toContain('0174');
    expect(said(found)).not.toContain('Carmen');
    expect(c.state.memory.verified).toBeNull();
  });

  it('one wrong read-back is not enough, and a yes is never wrong', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    await c.delegate([verify('720 555 0175', 'Luna')]);
    c.assistant("That's 720-555-0175?");
    c.caller('No, it ends 0174.');
    await c.delegate([verify('720 555 0174', 'Luna')]);
    c.assistant("That's 720-555-0174?");
    c.caller('Yes, that is it.');
    const out = await c.delegate([verify('720 555 0174', 'Luna')]);
    expect(out.errors).toEqual(['owner_check']);
    expect(c.state.readbacksWrong).toBe(1);
    expect(c.state.lastFourAsked).toBeNull();
  });

  it('two households sharing the last four digits with a pet of that name: nobody is found, and a request for the team', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    await w.backend.patients.create(RIVERBEND_CLINIC.id, { firstName: 'Mochi', lastName: 'Quinn', dob: '2021-01-01', phone: '+13035550172', guardianName: 'Avery Quinn', gender: 'female', species: 'cat' });
    await c.delegate([verify('720 555 0170', 'Mochi')]);
    c.assistant("That's 720-555-0170?");
    c.caller('No.');
    await c.delegate([verify('720 555 0170', 'Mochi')]);
    c.assistant("That's 720-555-0170?");
    c.caller('No, 720 555 0171.');
    const ask = await c.delegate([verify('720 555 0171', 'Mochi')]);
    expect(ask.errors).toEqual(['ask_last_four']);
    c.caller('0172, Mochi.');
    const out = await c.delegate([verify(null, 'Mochi', '0172')]);
    expect(out.errors).toEqual(['last_four_no_match']);
    expect(said(out)).toContain("I couldn't find one profile with those details.");
    expect(said(out)).toContain('create_callback');
    expect(c.state.verifiedPatient).toBeNull();
    // the same details are not searched again
    expect((await c.delegate([verify(null, 'Mochi', '0172')])).errors).toEqual(['not_verified']);
  });

  it('is never a way to search before the backend asked for it', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    const out = await c.delegate([verify(null, 'Luna', '0174')]);
    expect(out.errors).toEqual(['last_four_not_asked']);
    expect(c.state.verifiedPatient).toBeNull();
  });
});

describe('a number with no profile', () => {
  it('says so, then asks for the last four digits and the pet\'s name, or offers to add a new pet', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    await c.delegate([verify('720 555 0190')]);
    c.assistant("That's 720-555-0190?");
    c.caller('Yes.');
    const out = await c.delegate([verify('720 555 0190')]);
    expect(out.errors).toEqual(['no_pets_on_number']);
    expect(said(out)).toContain("I don't see a profile under that number.");
    expect(said(out)).toContain('What are the last four digits of the number the profile might be under');
    expect(c.state.lastFourAsked).toBe('no_profile');
    c.caller('Oh, try 0172, it is Biscuit.');
    const found = await c.delegate([verify(null, 'Biscuit', '0172')]);
    expect(found.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.firstName).toBe('Biscuit');
  });

  it('a caller who said the pet is new is not asked', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller('I want to register my new puppy.');
    await c.delegate([verify('720 555 0191')]);
    c.assistant("That's 720-555-0191?");
    c.caller('Yes.');
    const out = await c.delegate([verify('720 555 0191')]);
    expect(said(out)).not.toContain('last four digits');
  });

  it('a second no counts even when the planner asks for the last four digits itself, before another number (a live run)', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    await c.delegate([verify('720 555 0177', 'Luna')]);
    c.assistant("That's 720-555-0177?");
    c.caller('No, ese no es.');
    await c.delegate([verify('720 555 0178', 'Luna')]);
    c.assistant("That's 720-555-0178?");
    c.caller('No, ese tampoco.');
    c.assistant('¿Cuáles son los últimos cuatro dígitos del número de la ficha?');
    c.caller('0174; Luna.');
    const found = await c.delegate([verify(null, 'Luna', '0174')]);
    expect(found.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.firstName).toBe('Luna');
  });
});
