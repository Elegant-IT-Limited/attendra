// SPDX-License-Identifier: AGPL-3.0-only
import { PACKS, RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// Q1 (call quality, 2026-11-18): on both paths "the owner's name, the pet's name, the number ends 0101" from another
// number was refused as last_four_not_asked, then the four digits passed as the phone got number_not_opened and the call
// ended in a request for the team. Four digits the caller gives are searched with the owner's and the pet's names; a
// "phone" of four digits is those four; after a miss the whole number (read back digit by digit) is asked once more.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const said = (out: { results: { data: Record<string, unknown> }[] }) => JSON.stringify(out.results.map((r) => r.data));
const verify = (args: { owner?: string | null; pet?: string | null; phone?: string | null; last4?: string | null }) =>
  ({ tool: 'verify_caller', args: { owner_name: args.owner ?? null, pet_name: args.pet ?? null, phone: args.phone ?? null, phone_last4: args.last4 ?? null } }) as const;
// the caller ID of a phone with no pets on it (a made-up number)
const OTHER_PHONE = '+17205550199';

describe('four digits the caller gives with the owner\'s and the pet\'s names', () => {
  for (const lang of ['en', 'es'] as const) {
    it(`find the pet in one step, before anyone asked for them (${lang})`, async () => {
      const c = await w.call(OTHER_PHONE, { clinic });
      c.caller(lang === 'es' ? 'Hola, soy Carmen Ortiz. Mi perra es Luna. El número termina en 0174.' : 'Hi, this is Carmen Ortiz. My pet is Luna. The number ends 0174.');
      const out = await c.delegate([verify({ owner: 'Carmen Ortiz', pet: 'Luna', last4: '0174' })]);
      expect(out.errors).toEqual([null]);
      expect(out.results[0]!.data).toMatchObject({ verified: true, pet_name: 'Luna' });
      expect(c.state.verifiedPatient?.firstName).toBe('Luna');
      expect(said(out)).not.toMatch(/0174|ortiz/i);
    });
  }

  it('passed as the phone are the last four, not a number that can\'t be opened', async () => {
    const c = await w.call(OTHER_PHONE, { clinic });
    c.caller('Carmen Ortiz, for Luna. It\'s a different number, it ends 0174.');
    const out = await c.delegate([verify({ owner: 'Carmen Ortiz', pet: 'Luna', phone: '0174' })]);
    expect(out.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.firstName).toBe('Luna');
  });

  it('with no owner\'s name: the owner\'s name is asked once, keeping the digits, then the pet is found', async () => {
    const c = await w.call(OTHER_PHONE, { clinic });
    c.caller('It\'s Luna, the number ends 0174.');
    const ask = await c.delegate([verify({ pet: 'Luna', last4: '0174' })]);
    expect(ask.errors).toEqual(['owner_for_last_four']);
    expect(said(ask)).toContain(PACKS.en.ownerNameQuestion);
    c.caller('Carmen.');
    const found = await c.delegate([verify({ owner: 'Carmen', pet: 'Luna', last4: '0174' })]);
    expect(found.errors).toEqual([null]);
  });

  it('a pet\'s name given as the owner\'s is not an owner\'s name', async () => {
    const c = await w.call(OTHER_PHONE, { clinic });
    const out = await c.delegate([verify({ owner: 'Luna', pet: 'Luna', last4: '0174' })]);
    expect(out.errors).toEqual(['owner_for_last_four']);
  });

  it('with an owner\'s name that is not the one on file: nothing is said from the record, the whole number is asked once, then the team', async () => {
    const c = await w.call(OTHER_PHONE, { clinic });
    const miss = await c.delegate([verify({ owner: 'Daniel Brooks', pet: 'Luna', last4: '0174' })]);
    expect(miss.errors).toEqual(['number_again']);
    expect(said(miss)).toContain(PACKS.en.numberAgain({ pet: 'Luna' }));
    expect(said(miss)).not.toMatch(/carmen|ortiz/i);
    expect(said(miss)).not.toContain(PACKS.en.numberNotOpened);
    expect(c.state.verifiedPatient).toBeNull();
    // the whole number they give now is read back digit by digit before it is searched
    c.caller('It\'s 720 555 0174.');
    const readBack = await c.delegate([verify({ owner: 'Daniel Brooks', pet: 'Luna', phone: '720 555 0174' })]);
    expect(readBack.errors).toEqual(['confirm_number']);
    expect(said(readBack)).toContain("That's 7 2 0, 5 5 5, 0 1 7 4?");
    c.assistant("That's 7 2 0, 5 5 5, 0 1 7 4?");
    c.caller('Yes.');
    // still not the owner: the one answer and a request for the team, never a third way
    const last = await c.delegate([verify({ owner: 'Daniel Brooks', pet: 'Luna', phone: '720 555 0174' })]);
    expect(last.errors).toEqual(['number_not_opened']);
    expect(said(last)).toContain('create_callback');
  });
});

describe('a spoken number misheard, then said again', () => {
  for (const lang of ['en', 'es'] as const) {
    it(`gets one more try with the whole number, and the right one opens the profile (${lang})`, async () => {
      const c = await w.call(OTHER_PHONE, { clinic });
      if (lang === 'es') c.caller('Hola, soy Carmen, llamo por Luna.');
      // heard one digit wrong (a made-up number with nobody on it)
      c.caller(lang === 'es' ? 'Es el 720 555 0164.' : 'It is 720 555 0164.');
      await c.delegate([verify({ owner: 'Carmen', pet: 'Luna', phone: '720 555 0164' })]);
      c.assistant(lang === 'es' ? '¿Es el 7 2 0, 5 5 5, 0 1 6 4?' : "That's 7 2 0, 5 5 5, 0 1 6 4?");
      c.caller(lang === 'es' ? 'Sí.' : 'Yes.');
      const miss = await c.delegate([verify({ owner: 'Carmen', pet: 'Luna', phone: '720 555 0164' })]);
      expect(miss.errors).toEqual(['number_again']);
      expect(said(miss)).toContain(PACKS[lang].numberAgain({ pet: 'Luna' }));
      expect(said(miss)).not.toContain(PACKS[lang].numberNotOpened);
      c.caller(lang === 'es' ? 'Perdón, es el 720 555 0174. Carmen.' : 'Sorry, it is 720 555 0174. Carmen.');
      const readBack = await c.delegate([verify({ owner: 'Carmen', pet: 'Luna', phone: '720 555 0174' })]);
      expect(readBack.errors).toEqual(['confirm_number']);
      c.assistant(lang === 'es' ? '¿Es el 7 2 0, 5 5 5, 0 1 7 4?' : "That's 7 2 0, 5 5 5, 0 1 7 4?");
      c.caller(lang === 'es' ? 'Sí.' : 'Yes.');
      const found = await c.delegate([verify({ owner: 'Carmen', pet: 'Luna', phone: '720 555 0174' })]);
      expect(found.errors).toEqual([null]);
      expect(c.state.verifiedPatient?.firstName).toBe('Luna');
    });
  }
});
