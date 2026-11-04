// SPDX-License-Identifier: AGPL-3.0-only
import { RIVERBEND_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// An emergency at a clinic for animals is decided by its signs, not the word. Two test calls were held by the bare word
// ("she had an emergency, she was admitted for surgery", "I think it's an emergency... no, forget it, he's not hurt"):
// every lookup was refused and the hospital was said four times. The red flags must still hold the call at once.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); });
afterAll(() => w.t.close());

const open = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const instructions = (out: { type: string; content?: string }[]) => out.filter((o) => o.type === 'instructions').map((o) => o.content ?? '').join(' ');
const FIND = { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } } as const;

describe('the word "emergency" alone at a vet clinic', () => {
  for (const said of [
    'My dog had an emergency last week, I need a check-up.',
    'She had emergency surgery last month and I want to book her follow-up.',
    'Can I see the emergency doctor, Dr. Ruiz, on Friday?',
    'Mi perra tuvo una emergencia la semana pasada, necesito una revisión.',
  ]) {
    it(`does not hold the call: "${said}"`, async () => {
      const c = await w.call('+17205550172', { clinic: open });
      const out = c.caller(said);
      expect(c.state.emergencyLocked).toBe(false);
      expect(c.state.emergency).toBeNull();
      // the past, a planned surgery or a title: no question at all, and never the script
      expect(instructions(out)).not.toMatch(/in danger right now|en peligro ahora mismo/);
      expect(instructions(out)).not.toMatch(/take your pet to|lleve a su mascota/);
      const [slots] = (await c.delegate([FIND])).results;
      expect(slots!.ok).toBe(true);
    });
  }

  it('asks once, and a no lets the booking carry on', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    c.caller("I think it's an emergency, I want to check on my cat.");
    c.assistant('Is your cat in danger right now, like trouble breathing, bleeding or a collapse?');
    const out = c.caller("No, it's fine, forget about it, he's not hurt. Just give me a time with Dr. Ruiz.");
    expect(instructions(out)).toContain('not in danger');
    expect(c.state.emergencyLocked).toBe(false);
    // the word again is not asked about twice
    expect(instructions(c.caller('it was not really an emergency'))).not.toContain('in danger right now');
    expect((await c.delegate([FIND])).results[0]!.ok).toBe(true);
  });

  it('asks once when the word is unclear, and a yes to another question since is not a yes to danger (a test run)', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    const out = c.caller('I think it is an emergency, I want Biscuit checked.');
    expect(instructions(out)).toContain('in danger right now');
    c.assistant('Is Biscuit in danger right now, like trouble breathing, bleeding or a collapse?');
    c.assistant("Sure. Is your pet's profile under the number you're calling from, ending 0172?");
    c.caller("Yes, that's the number on file.");
    expect(c.state.emergencyLocked).toBe(false);
    expect((await c.delegate([FIND])).results[0]!.ok).toBe(true);
  });

  it('holds the call on a yes to the question', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    c.caller('This is an emergency.');
    c.assistant('Is your dog in danger right now, like trouble breathing, bleeding or a collapse?');
    const out = c.caller('Yes, she is.');
    expect(c.state.emergencyLocked).toBe(true);
    expect(instructions(out)).toContain('Front Range Pet Emergency');
  });

  it('holds the call on a yes in Spanish', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    c.caller('Es una emergencia.');
    c.assistant('¿Su mascota está en peligro ahora mismo, por ejemplo le cuesta respirar, sangra o se desmayó?');
    c.caller('Sí, ahora mismo.');
    expect(c.state.emergencyLocked).toBe(true);
  });

  for (const sign of ['she is not breathing', 'he ate rat poison', 'my dog was hit by a car', 'she is having a seizure', 'my cat can\'t pee', 'mi perro no puede respirar', 'se comió chocolate']) {
    it(`still holds the call at once on a real sign: "${sign}"`, async () => {
      const c = await w.call('+17205550172', { clinic: open });
      const out = c.caller(`It's an emergency, ${sign}.`);
      expect(c.state.emergencyLocked).toBe(true);
      expect(instructions(out)).toMatch(/Front Range Pet Emergency/);
      expect((await c.delegate([FIND])).results[0]!.data.error).toBe('emergency_in_progress');
    });
  }
});

describe('after the emergency script', () => {
  it('says the hospital once, then offers the team instead of repeating it, and "he\'s fine" lets the call go on', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    c.caller('My dog ate chocolate.');
    // before the script is said: the refusal asks for it once
    expect((await c.delegate([FIND])).results[0]!.data.error).toBe('emergency_in_progress');
    c.assistant('This sounds like an emergency. Please take your pet to Front Range Pet Emergency right away. If a person is hurt or in danger, call 911.');
    expect(c.state.emergencyScriptSaid).toBe(true);
    c.caller('Can I book a check-up for tomorrow?');
    const [refused] = (await c.delegate([FIND])).results;
    expect(refused!.data.error).toBe('emergency_in_progress');
    expect(JSON.stringify(refused!.data)).toContain('do not say it again');
    // the next step, never a loop: at 8 pm nobody can take a transfer, so an urgent request for the team
    expect(JSON.stringify(refused!.data)).toContain('I can send our team an urgent message');
    c.assistant('I can\'t book a routine visit for your pet while this is going on. I can send our team an urgent message to call you back as soon as they can. Would you like that?');
    c.caller("No, he's fine now, it's not an emergency. He only had a tiny bit.");
    expect(c.state.emergencyLocked).toBe(false);
    expect(c.state.emergency?.kind).toBe('pet_toxin'); // still on the record
    expect((await c.delegate([FIND])).results[0]!.ok).toBe(true);
  });

  it('lifts it on "no, forget it, he\'s not hurt" said across pieces of speech', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    c.caller('my dog swallowed a sock');
    c.assistant('Please take your pet to Front Range Pet Emergency right away.');
    c.caller('No, forget it,');
    c.caller(" he's not hurt, just give me a schedule.");
    expect(c.state.emergencyLocked).toBe(false);
  });

  it('never lifts a person in danger', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    c.caller('my dog died and I want to kill myself');
    c.assistant('Please call or text 988 now.');
    c.caller("No, forget it, I'm fine.");
    expect(c.state.emergencyLocked).toBe(true);
  });
});

describe('the person-in-danger number', () => {
  it('is never a guess for a clinic whose country is not known', async () => {
    const abroad = { ...open, phoneNumbers: ['+9771234567'], emergencyNumber: undefined };
    const c = await w.call('+17205550172', { clinic: abroad });
    const out = instructions(c.caller('my dog ate rat poison'));
    expect(out).toContain('call your local emergency number');
    expect(out).not.toContain('112');
  });
});
