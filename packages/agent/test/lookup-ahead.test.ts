// SPDX-License-Identifier: AGPL-3.0-only
import { PACKS, RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askedCallerIdNumber, petNamedIn, saysCallingNumber } from '../src';
import { world } from './support';

// Call speed (2026-11-19): the lookup the caller's words make plain runs before the voice replies (lookup-ahead), so the
// voice answers in one model round. Identity is verified as soon as the caller finishes saying it: a yes to the caller-ID
// question, a yes to a number's read-back, a pet on the number named after the pick question. Hours go to clinic_now.
// Never a guess: a pet not on the number, "new", an emergency or a change waiting for a yes runs nothing.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
// Biscuit's household in the seed (a made-up number)
const PHONE = '+17205550172';
const question = (lang: 'en' | 'es') => PACKS[lang].profileNumberQuestion({ last4: '0172' });

describe('lookup-ahead: identity, as soon as the caller says it', () => {
  for (const lang of ['en', 'es'] as const) {
    it(`a yes to the caller-ID question looks up the number's pets, then the pet named from the pick question is found (${lang})`, async () => {
      const c = await w.call(PHONE, { clinic });
      await c.agent.preloadHousehold();
      c.caller(lang === 'es' ? 'Hola, quiero una cita.' : 'Hi, I want to book a visit.');
      c.assistant(question(lang));
      expect(c.agent.repliesAfterWords()).toBe(true);
      c.caller(lang === 'es' ? 'Sí.' : 'Yes.');
      const ask = c.agent.speculate();
      expect(ask).toEqual({ name: 'verify_caller', args: { phone: null, pet_name: null, owner_name: null, phone_last4: null } });
      const pick = (await c.agent.onToolCall(ask!.name, ask!.args)).output;
      expect(pick.data).toMatchObject({ pets_on_number: expect.arrayContaining(['Biscuit']) });
      c.assistant(String(pick.spoken ?? pick.say));
      expect(c.agent.repliesAfterWords()).toBe(true);
      c.caller(lang === 'es' ? 'Para Biscuit.' : 'For Biscuit.');
      const named = c.agent.speculate();
      expect(named).toEqual({ name: 'verify_caller', args: { phone: null, pet_name: 'Biscuit', owner_name: null, phone_last4: null } });
      const found = (await c.agent.onToolCall(named!.name, named!.args)).output;
      expect(found).toMatchObject({ ok: true, outcome: 'found' });
      expect(c.state.verifiedPatient?.firstName).toBe('Biscuit');
    });
  }

  it('a yes that names a pet on the number goes straight to that pet (the household read as the call started)', async () => {
    const c = await w.call(PHONE, { clinic });
    await c.agent.preloadHousehold();
    c.caller('Hi, I want to book a check-up for Biscuit.');
    c.assistant(question('en'));
    c.caller('Yes, that\'s right.');
    expect(c.agent.speculate()).toEqual({ name: 'verify_caller', args: { phone: null, pet_name: 'Biscuit', owner_name: null, phone_last4: null } });
  });

  it('a pet named that is not on the number gets the pick question, as the voice would call it; "new", a no, or a question it did not ask runs nothing', async () => {
    const stranger = await w.call(PHONE, { clinic });
    await stranger.agent.preloadHousehold();
    stranger.caller('Hi, I want to book for Waffles.');
    stranger.assistant(question('en'));
    stranger.caller('Yes.');
    expect(stranger.agent.speculate()).toEqual({ name: 'verify_caller', args: { phone: null, pet_name: null, owner_name: null, phone_last4: null } });

    const fresh = await w.call(PHONE, { clinic });
    fresh.caller('I want to book a visit.');
    fresh.assistant(question('en'));
    fresh.caller('Yes, but it is a new puppy.');
    expect(fresh.agent.speculate()).toBeNull();

    const no = await w.call(PHONE, { clinic });
    no.caller('I want to book a visit.');
    no.assistant(question('en'));
    no.caller('No, it is under my wife\'s number.');
    expect(no.agent.speculate()).toBeNull();

    const other = await w.call(PHONE, { clinic });
    other.caller('I want to book a visit.');
    other.assistant('Sure. What is the visit for?');
    other.caller('Yes, a check-up.');
    expect(other.agent.speculate()).toBeNull();
    expect(other.agent.repliesAfterWords()).toBe(false);
  });

  it('a yes to the read-back of a number they said searches that number, as the read-back\'s line says', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller('Biscuit, on 720 555 0172.');
    const asked = (await c.agent.onToolCall('verify_caller', { owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172', phone_last4: null })).output;
    expect(asked.outcome).toBe('confirm_number');
    c.assistant("That's 7 2 0, 5 5 5, 0 1 7 2?");
    expect(c.agent.repliesAfterWords()).toBe(true);
    c.caller('Yes.');
    const spec = c.agent.speculate();
    expect(spec?.name).toBe('verify_caller');
    expect(String(spec!.args.phone).replace(/\D/g, '')).toMatch(/7205550172$/);
    expect(spec!.args.pet_name).toBe('Biscuit');
    // the read-back answered: the search goes on to the owner's name, as when the voice calls it
    expect((await c.agent.onToolCall(spec!.name, spec!.args)).output.outcome).toBe('owner_check');
  });
});

describe('lookup-ahead: hours and the first turn', () => {
  for (const [lang, words] of [['en', 'Hi, are you open on Saturday?'], ['es', 'Hola, ¿a qué hora cierran hoy?']] as const) {
    it(`an hours question runs clinic_now, whatever the stage (${lang})`, async () => {
      const c = await w.call(PHONE, { clinic });
      // the first turn waits for the caller's words anyway: it may run a lookup ahead
      expect(c.agent.repliesAfterWords()).toBe(true);
      c.caller(words);
      expect(c.agent.speculate()).toEqual({ name: 'clinic_now', args: {} });
    });
  }

  it('a greeting alone runs nothing', async () => {
    const c = await w.call(PHONE, { clinic });
    c.caller('Hi, how are you?');
    expect(c.agent.speculate()).toBeNull();
  });

  it('runs nothing while an emergency is open or a change waits for a yes', async () => {
    const c = await w.call(PHONE, { clinic });
    c.caller('My dog ate rat poison, is the clinic open?');
    expect(c.state.emergencyLocked || !!c.state.emergencyCase).toBe(true);
    expect(c.agent.speculate()).toBeNull();
    expect(c.agent.repliesAfterWords()).toBe(false);
  });
});

describe('the words lookup-ahead reads', () => {
  it('knows the caller-ID question by the profile and its last four digits, as digits or as words', () => {
    expect(askedCallerIdNumber('sure is your pet s profile under the number you re calling from ending 0172', PHONE)).toBe(true);
    expect(askedCallerIdNumber('is the profile under the number ending zero one seven two', PHONE)).toBe(true);
    expect(askedCallerIdNumber('el perfil esta bajo el numero desde el que llama que termina en 0172', PHONE)).toBe(true);
    expect(askedCallerIdNumber('is the profile under the number ending 0199', PHONE)).toBe(false);
    expect(askedCallerIdNumber('what is the visit for', PHONE)).toBe(false);
    expect(askedCallerIdNumber('is your pet s profile under the number ending 0172', null)).toBe(false);
  });

  it('a pet is named by every word of its name, and only one', () => {
    expect(petNamedIn('yes for Biscuit please', ['Biscuit', 'Max'])).toBe('Biscuit');
    expect(petNamedIn('Mr Whiskers', ['Mr. Whiskers'])).toBe('Mr. Whiskers');
    expect(petNamedIn('both Biscuit and Max', ['Biscuit', 'Max'])).toBeNull();
    expect(petNamedIn('a new one', ['Biscuit'])).toBeNull();
  });
});

// a live run (2026-11-26): "Hola, soy Linh Nguyen, desde el número del que llamo. ¿Puede venir Biscuit…?" still got the
// caller-ID question, where "on the number I'm calling from" in English did not. Said up front, it is the caller-ID yes
describe('ES-CALLERID: the profile said to be on the number they call from, up front, EN and ES', () => {
  const ES = ['desde el número del que llamo', 'del número del que llamo', 'con este número', 'este mismo número', 'el número desde el que llamo', 'el mismo número', 'con el que estoy llamando'];
  const EN = ["on the number I'm calling from", 'the number I am calling from', 'on this number', 'under this same number', "it's the same number"];
  it.each([...ES, ...EN])('ES-CALLERID: "%s" is the number they are calling from', (phrase) => {
    expect(saysCallingNumber(phrase)).toBe(true);
  });
  it.each(['no es este número', 'es otro número', "it's not this number", 'a different number', 'Can Biscuit come in tomorrow?', 'Llámeme a otro número'])('ES-CALLERID: "%s" is not', (phrase) => {
    expect(saysCallingNumber(phrase)).toBe(false);
  });

  for (const [lang, line] of [
    ['es', 'Hola, soy Linh Nguyen, desde el número del que llamo. ¿Puede venir Biscuit mañana por la mañana para una consulta por enfermedad?'],
    ['es', 'Hola, quiero una cita para Biscuit, con este número.'],
    ['en', "Hi, Linh Nguyen, on the number I'm calling from. Can Biscuit come in tomorrow morning for a sick visit?"],
  ] as const) {
    it(`ES-CALLERID: said in the first turn, the caller ID's number is looked up at once, with the pet (${lang})`, async () => {
      const c = await w.call(PHONE, { clinic });
      await c.agent.preloadHousehold();
      if (lang === 'es') c.state.language = 'es';
      c.caller(line);
      expect(c.agent.speculate()).toEqual({ name: 'verify_caller', args: { phone: null, pet_name: 'Biscuit', owner_name: null, phone_last4: null } });
    });
  }

  it('ES-CALLERID: "no es este número" or a new pet runs no caller-ID lookup', async () => {
    const c = await w.call(PHONE, { clinic });
    await c.agent.preloadHousehold();
    c.state.language = 'es';
    c.caller('Hola, quiero una cita para Biscuit, pero no es este número.');
    expect(c.agent.speculate()?.name).not.toBe('verify_caller');
    const d = await w.call(PHONE, { clinic });
    await d.agent.preloadHousehold();
    d.caller("Hi, on the number I'm calling from, I want to book for my new puppy.");
    expect(d.agent.speculate()?.name).not.toBe('verify_caller');
  });
});

