// SPDX-License-Identifier: AGPL-3.0-only
import { seedRiverbend } from '@attendra/db';
import { RIVERBEND_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// The number first: as soon as a caller wants to book, move or cancel, the assistant asks what number the pet's
// profile is under, reads a spoken number back before searching, and says what the lookup found before anything else.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const said = (out: { results: { data: Record<string, unknown> }[] }) => JSON.stringify(out.results.map((r) => r.data));
const verify = (phone: string | null, pet: string | null = null) => ({ tool: 'verify_caller', args: { owner_name: null, pet_name: pet, phone } }) as const;

describe('a spoken number is read back before the search', () => {
  it('searches only after a yes, and a correction is read back again', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    const first = await c.delegate([verify('seven two oh, five five five, oh one seven three', 'Biscuit')]);
    expect(first.errors).toEqual(['confirm_number']);
    expect(said(first)).toContain("That's 720-555-0173?");
    c.assistant("That's 720-555-0173?");
    c.caller('No, it ends 0172.');
    const second = await c.delegate([verify('720 555 0172', 'Biscuit')]);
    expect(second.errors).toEqual(['confirm_number']);
    expect(said(second)).toContain("That's 720-555-0172?");
    c.assistant("That's 720-555-0172?");
    c.caller('Yes, that one.');
    // a number said is checked by the caller's name, asked once, before anything from its records is used
    const named = await c.delegate([verify('720 555 0172', 'Biscuit')]);
    expect(named.errors).toEqual(['owner_check']);
    expect(said(named)).toContain('And your name?');
    c.assistant('And your name?');
    c.caller('Linh.');
    const found = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit', phone: '720 555 0172' } }]);
    expect(found.errors).toEqual([null]);
    expect(c.state.memory.verified).toBe('name_match');
    expect(c.state.verifiedPatient?.firstName).toBe('Biscuit');
    // said first, before any times
    expect(said(found)).toContain('Say first, in these words: \\"I found Biscuit, your dog.\\"');
  });

  it('reads "double" and "triple" as digits', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    const out = await c.delegate([verify('seven two oh, triple five, oh one seven two', 'Biscuit')]);
    expect(said(out)).toContain("That's 720-555-0172?");
  });

  it('a no without a new number keeps asking, never searches', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    await c.delegate([verify('720 555 0172', 'Biscuit')]);
    c.assistant("That's 720-555-0172?");
    c.caller('No.');
    const again = await c.delegate([verify('720 555 0172', 'Biscuit')]);
    expect(again.errors).toEqual(['confirm_number']);
    expect(c.state.verifiedPatient).toBeNull();
  });

  it('needs no read-back for the number they are calling from', async () => {
    const c = await w.call('+17205550172', { clinic });
    const out = await c.delegate([verify('720-555-0172', 'Biscuit')]);
    expect(out.errors).toEqual([null]);
  });

  it('says the lookup result first in Spanish too', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hola, quiero una cita para Biscuit.');
    const out = await c.delegate([verify(null, 'Biscuit')]);
    expect(said(out)).toContain('Encontré a Biscuit, su perro.');
  });

  it('says the pet is not under that number first', async () => {
    const c = await w.call('+17205550172', { clinic });
    const out = await c.delegate([verify(null, 'Ginger')]);
    expect(out.errors).toEqual(['not_verified']);
    expect(said(out)).toContain("I don't see Ginger under that number.");
  });
});

// the opening (2026-11-14, option C): with caller ID the voice has the number question from the start of the call and
// judges itself whether the caller wants a visit (callerIdLine, voice-engine); the agent sends nothing for it on a turn
describe('the number question with caller ID', () => {
  it('is never handed over turn by turn: not for a booking, not for a question', async () => {
    const c = await w.call('+17205550172', { clinic });
    const ins = (said: string) => c.caller(said).filter((o) => o.type === 'instructions');
    expect(ins('How much is a check-up?')).toEqual([]);
    expect(ins('Hi, my dog needs a check-up.')).toEqual([]);
  });

  it('the planner model\'s intent wins over the word lists, which stay the fallback', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('How much is a check-up?');
    expect(c.state.memory.get('intent')).toBeUndefined();
    c.state.memory.fromModel('book', 0);
    c.caller('I want to cancel it, actually.'); // words: cancel; the model's reading stands until it reads again
    expect(c.state.memory.fact('intent')).toMatchObject({ value: 'book', source: 'model' });
    c.state.memory.fromModel('cancel', 1);
    expect(c.state.memory.get('intent')).toBe('cancel');
  });
});
