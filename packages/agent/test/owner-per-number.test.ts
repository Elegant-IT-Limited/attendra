// SPDX-License-Identifier: AGPL-3.0-only
import { seedRiverbend } from '@attendra/db';
import { PACKS, RIVERBEND_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// Each number a caller says is checked with the owner's name given for THAT number (2026-11-11, browser test calls at a
// new clinic): a second household's number was checked with the first caller's name, or with a pet's name, and never
// opened. The rule from 2026-11-09 stays: nothing from a record is opened or named before the owner's name matches, and a
// wrong name gets the same words as a number with no profile.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const ASK = PACKS.en.ownerNameQuestion;
type Out = { results: { data: Record<string, unknown> }[] };
const said = (out: Out) => JSON.stringify(out.results.map((r) => r.data));
const verify = (phone: string | null, pet: string | null, owner: string | null) => ({ tool: 'verify_caller', args: { owner_name: owner, pet_name: pet, phone } }) as const;

/** A browser test call (no caller ID) that has found Biscuit on 720-555-0172 by Linh's name. */
async function linhFoundBiscuit() {
  const c = await w.call(null, { clinic, channel: 'web' });
  c.caller('Hi, this is Linh. I need a visit for Biscuit, the number is 720 555 0172.');
  expect((await c.delegate([verify('720 555 0172', 'Biscuit', 'Linh')])).errors).toEqual(['confirm_number']);
  c.assistant("That's 720-555-0172?");
  c.caller('Yes.');
  const found = await c.delegate([verify('720 555 0172', 'Biscuit', 'Linh')]);
  expect(found.errors).toEqual([null]);
  expect(c.state.verifiedPatient?.firstName).toBe('Biscuit');
  return c;
}

describe('a second number on the same call is checked with its own owner\'s name', () => {
  it('opens the second household when the caller gives its owner\'s name with the number', async () => {
    const c = await linhFoundBiscuit();
    c.caller("And my neighbour's dog Luna, under 720 555 0174. The owner is Carmen.");
    expect((await c.delegate([verify('720 555 0174', 'Luna', 'Carmen')])).errors).toEqual(['confirm_number']);
    c.assistant("That's 720-555-0174?");
    c.caller('Yes.');
    const found = await c.delegate([verify('720 555 0174', 'Luna', 'Carmen')]);
    expect(found.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.firstName).toBe('Luna');
    expect(c.state.memory.verified).toBe('name_match');
  });

  it('asks the owner\'s name for the second number instead of reusing the first caller\'s, then opens it', async () => {
    const c = await linhFoundBiscuit();
    c.caller('Can I also book Luna? She is under 720 555 0174.');
    // the model carries the first caller's name over to the new number: it is not taken for this one
    expect((await c.delegate([verify('720 555 0174', 'Luna', 'Linh')])).errors).toEqual(['confirm_number']);
    c.assistant("That's 720-555-0174?");
    c.caller('Yes.');
    const asked = await c.delegate([verify('720 555 0174', 'Luna', 'Linh')]);
    expect(asked.errors).toEqual(['owner_check']);
    expect(said(asked)).toContain(ASK);
    // still Biscuit's call: nothing of Luna's was opened or named
    expect(c.state.verifiedPatient?.firstName).toBe('Biscuit');
    expect(said(asked)).not.toMatch(/Carmen|Ortiz/);
    c.assistant(ASK);
    c.caller('Carmen Ortiz.');
    const found = await c.delegate([verify('720 555 0174', 'Luna', 'Carmen Ortiz')]);
    expect(found.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.firstName).toBe('Luna');
  });

  it('a name said again for the second number counts, even when it is the first caller\'s', async () => {
    const c = await linhFoundBiscuit();
    c.caller('Also Pepper, under 720 555 0173.');
    await c.delegate([verify('720 555 0173', 'Pepper', 'Linh')]);
    c.assistant("That's 720-555-0173?");
    c.caller('Yes.');
    expect((await c.delegate([verify('720 555 0173', 'Pepper', 'Linh')])).errors).toEqual(['owner_check']);
    c.assistant(ASK);
    // Linh again, said for this number: it is checked (and is not the owner on file there)
    c.caller('Linh.');
    const out = await c.delegate([verify('720 555 0173', 'Pepper', 'Linh')]);
    expect(out.errors).toEqual(['number_not_opened']);
    expect(c.state.memory.nameCheck).toMatchObject({ digits: '17205550173', result: 'no_match' });
  });

  it('a wrong owner\'s name for the second number is refused in the same words as a number with no profile', async () => {
    const wrong = await linhFoundBiscuit();
    wrong.caller('And Luna, under 720 555 0174.');
    await wrong.delegate([verify('720 555 0174', 'Luna', null)]);
    wrong.assistant("That's 720-555-0174?");
    wrong.caller('Yes.');
    expect((await wrong.delegate([verify('720 555 0174', 'Luna', null)])).errors).toEqual(['owner_check']);
    wrong.assistant(ASK);
    wrong.caller('Maria.');
    const refused = await wrong.delegate([verify('720 555 0174', 'Luna', 'Maria')]);
    expect(refused.errors).toEqual(['number_not_opened']);
    expect(said(refused)).not.toMatch(/Carmen|Ortiz|Luna, your/);

    const none = await linhFoundBiscuit();
    none.caller('And Rolo, under 720 555 0199.');
    await none.delegate([verify('720 555 0199', 'Rolo', null)]);
    none.assistant("That's 720-555-0199?");
    none.caller('Yes.');
    expect((await none.delegate([verify('720 555 0199', 'Rolo', null)])).errors).toEqual(['owner_check']);
    none.assistant(ASK);
    none.caller('Maria.');
    const nothing = await none.delegate([verify('720 555 0199', 'Rolo', 'Maria')]);
    expect(nothing.errors).toEqual(['number_not_opened']);
    // one answer whatever is or isn't on the number
    expect(said(nothing)).toBe(said(refused));
  });
});

describe('a pet\'s name is never the owner\'s', () => {
  it('a pet named with a surname ("Luna Ortiz") is not taken as the owner: the owner\'s name is asked', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller('I want to book Luna Ortiz, the number is 720 555 0174.');
    await c.delegate([verify('720 555 0174', 'Luna', 'Luna Ortiz')]);
    c.assistant("That's 720-555-0174?");
    c.caller('Yes.');
    const asked = await c.delegate([verify('720 555 0174', 'Luna', 'Luna Ortiz')]);
    expect(asked.errors).toEqual(['owner_check']);
    // no check was made with the pet's name
    expect(c.state.memory.nameCheck).toBeNull();
    c.assistant(ASK);
    c.caller("It's Carmen.");
    const found = await c.delegate([verify('720 555 0174', 'Luna', 'Carmen')]);
    expect(found.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.firstName).toBe('Luna');
  });
});

describe('a pet registered on one call is found on the next', () => {
  it('registers a new pet under a spoken number, then a second call opens it by the number and the owner\'s name', async () => {
    const first = await w.call(null, { clinic, channel: 'web' });
    first.caller('My dog Nimbus is new here. The number is 720 555 0181 and my name is Priya.');
    const reg = { tool: 'register_patient', args: { pet_name: 'Nimbus', owner_name: 'Priya', species: 'dog', sex: 'male', birthday_or_age: '3 years', phone: '720 555 0181' } } as const;
    let out = await first.delegate([reg]);
    for (let i = 0; i < 3 && out.errors[0] !== null; i++) {
      if (out.errors[0] === 'confirm_number') { first.assistant("That's 720-555-0181?"); first.caller('Yes.'); }
      else if (out.errors[0] === 'owner_check') { first.assistant(ASK); first.caller('Priya.'); }
      else break;
      out = await first.delegate([reg]);
    }
    expect(out.errors).toEqual([null]);

    const second = await w.call(null, { clinic, channel: 'web' });
    second.caller('Hi, I need a visit for Nimbus, under 720 555 0181.');
    expect((await second.delegate([verify('720 555 0181', 'Nimbus', null)])).errors).toEqual(['confirm_number']);
    second.assistant("That's 720-555-0181?");
    second.caller('Yes.');
    expect((await second.delegate([verify('720 555 0181', 'Nimbus', null)])).errors).toEqual(['owner_check']);
    second.assistant(ASK);
    second.caller('Priya.');
    const found = await second.delegate([verify('720 555 0181', 'Nimbus', 'Priya')]);
    expect(found.errors).toEqual([null]);
    expect(second.state.verifiedPatient?.firstName).toBe('Nimbus');
  });
});
