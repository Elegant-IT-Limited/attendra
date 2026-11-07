// SPDX-License-Identifier: AGPL-3.0-only
import { EMERGENCY_LINES, RIVERBEND_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// An emergency at a clinic for animals is decided by its signs, not the word. Two test calls were held by the bare word
// ("she had an emergency, she was admitted for surgery", "I think it's an emergency... no, forget it, he's not hurt"):
// every lookup was refused and the hospital was said four times. A red flag gets the one question at once (batch 1b),
// and the caller's answer routes it.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); });
afterAll(() => w.t.close());

const open = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
// a clinic that refers emergencies to its hospital (no on-call line): the route on a yes is the hospital
const refer = { ...open, emergencyTransferEnabled: false };
const QUESTION = EMERGENCY_LINES.question('en');
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
      expect(instructions(out)).not.toMatch(/in danger right now|en peligro ahora mismo|still an emergency right now|sigue siendo una emergencia/);
      expect(instructions(out)).not.toMatch(/take your pet to|lleve a su mascota/);
      const [slots] = (await c.delegate([FIND])).results;
      expect(slots!.ok).toBe(true);
    });
  }

  it('asks the one question, and a clear no lets the booking carry on, with the "if it comes back" line once', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    expect(instructions(c.caller("I think it's an emergency, I want to check on my cat."))).toContain(QUESTION);
    c.assistant(QUESTION);
    const out = c.caller("No, it's fine, forget about it, he's not hurt. Just give me a time with Dr. Ruiz.");
    expect(instructions(out)).toContain('If it comes back');
    expect(c.state.emergencyLocked).toBe(false);
    expect(c.state.emergencyNotes).toEqual(['Owner reported "an emergency" earlier on this call.']);
    // the word again is not asked about twice
    expect(instructions(c.caller('it was not really an emergency'))).not.toContain(QUESTION);
    expect((await c.delegate([FIND])).results[0]!.ok).toBe(true);
  });

  it('a yes to another question asked since is not a yes to danger (a test run)', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    expect(instructions(c.caller('I think it is an emergency, I want Biscuit checked.'))).toContain(QUESTION);
    c.assistant(QUESTION);
    c.assistant("Sure. Is your pet's profile under the number you're calling from, ending 0172?");
    c.caller("Yes, that's the number on file.");
    expect(c.state.emergencyLocked).toBe(false);
    expect(c.state.emergencyCase?.stage).toBe('asked');
  });

  it('routes on a yes to the question: the hospital for a clinic that refers, a live transfer for one that handles emergencies', async () => {
    const c = await w.call('+17205550172', { clinic: refer });
    c.caller('This is an emergency.');
    c.assistant(QUESTION);
    const out = c.caller('Yes, she is.');
    expect(c.state.emergencyLocked).toBe(true);
    expect(instructions(out)).toContain('Front Range Pet Emergency');
    const team = await w.call('+17205550172', { clinic: open });
    team.caller('This is an emergency.');
    team.assistant(QUESTION);
    const put = team.caller('Yes, please help.');
    expect(instructions(put)).toContain("I'm putting you through to our team now.");
    expect(put.find((o) => o.type === 'transfer')).toMatchObject({ uri: 'tel:+17205550179' });
    expect(team.state.emergencyResult).toBe('transferred');
  });

  it('a sign that may be mild: "not sure" is the soonest sick visit, never a transfer; heavy or nonstop still routes (a live run)', async () => {
    const BORDERLINE_Q = EMERGENCY_LINES.borderlineQuestion('en');
    const unsure = await w.call('+17205550172', { clinic: open });
    expect(instructions(unsure.caller("I'd like to book a sick visit for Biscuit, he's been off his food."))).toContain(BORDERLINE_Q);
    unsure.assistant(BORDERLINE_Q);
    const out = unsure.caller("I'm not sure.");
    expect(out.some((o) => o.type === 'transfer')).toBe(false);
    expect(instructions(out)).toContain('soonest visit');
    expect(unsure.state.emergencyLocked).toBe(false);
    const heavy = await w.call('+17205550172', { clinic: open });
    heavy.caller("Biscuit's been sick, can I bring him in now?");
    heavy.assistant(BORDERLINE_Q);
    const routed = heavy.caller("Yes, he's been vomiting nonstop all day.");
    expect(routed.find((o) => o.type === 'transfer')).toMatchObject({ uri: 'tel:+17205550179' });
  });

  it('the voice model can never put the caller through to the on-call line itself: before the answer, after a clear no, or in refer mode', async () => {
    const TRANSFER = { tool: 'transfer_call', args: { target: 'on_call' } } as const;
    // asked, no answer yet
    const asked = await w.call('+17205550172', { clinic: open });
    asked.caller('My dog is choking, his throat is swelling.');
    asked.assistant(QUESTION);
    const [waiting] = (await asked.delegate([TRANSFER])).results;
    expect(waiting).toMatchObject({ ok: false, data: { error: 'pet_flagged' } });
    // a clear no
    const cleared = await w.call('+17205550172', { clinic: open });
    cleared.caller('My dog is choking, his throat is swelling.');
    cleared.assistant(QUESTION);
    cleared.caller("No, not now, he's fine. I just want a regular checkup.");
    const [after] = (await cleared.delegate([TRANSFER])).results;
    expect(after).toMatchObject({ ok: false, data: { error: 'emergency_cleared' } });
    // refer mode, after a yes: the hospital, never the on-call line
    const referred = await w.call('+17205550172', { clinic: refer });
    referred.caller('My dog is choking, his throat is swelling.');
    referred.assistant(QUESTION);
    referred.caller('Yes, he still is.');
    const done = await referred.delegate([TRANSFER]);
    expect(done.results[0]!.ok).toBe(false);
    expect(done.some((o) => o.type === 'transfer')).toBe(false);
  });

  it('routes on a yes in Spanish, and on "not sure"', async () => {
    const c = await w.call('+17205550172', { clinic: { ...refer, languages: ['en', 'es'] } });
    c.caller('Es una emergencia.');
    c.assistant(EMERGENCY_LINES.question('es'));
    c.caller('Sí, ahora mismo.');
    expect(c.state.emergencyLocked).toBe(true);
    const unsure = await w.call('+17205550172', { clinic: refer });
    unsure.caller('My dog is choking.');
    unsure.assistant(QUESTION);
    expect(instructions(unsure.caller("I'm not sure, I don't know."))).toContain('Front Range Pet Emergency');
  });

  for (const sign of ['she is not breathing', 'he ate rat poison', 'my dog was hit by a car', 'she is having a seizure', 'my cat can\'t pee', 'mi perro no puede respirar', 'se comió chocolate']) {
    it(`a real sign gets the question at once, and nothing for that pet is booked until it is answered: "${sign}"`, async () => {
      const c = await w.call('+17205550172', { clinic: refer });
      const out = c.caller(`It's an emergency, ${sign}.`);
      expect(c.state.emergencyCase?.stage).toBe('flagged');
      expect(instructions(out)).toMatch(/still an emergency right now|sigue siendo una emergencia/i);
      expect((await c.delegate([FIND])).results[0]!.data.error).toBe('pet_flagged');
      c.assistant(QUESTION);
      expect(instructions(c.caller('Yes.'))).toMatch(/Front Range Pet Emergency/);
      expect(c.state.emergencyLocked).toBe(true);
      expect((await c.delegate([FIND])).results[0]!.data.error).toBe('emergency_in_progress');
    });
  }
});

describe('after the route', () => {
  it('says the hospital once, then offers the team instead of repeating it, and "he\'s fine now" lifts it', async () => {
    const c = await w.call('+17205550172', { clinic: refer });
    c.caller('My dog ate chocolate.');
    expect((await c.delegate([FIND])).results[0]!.data.error).toBe('pet_flagged');
    c.assistant(QUESTION);
    c.caller('Yes, he did, just now.');
    // before the hospital is said: the refusal asks for it once
    expect((await c.delegate([FIND])).results[0]!.data.error).toBe('emergency_in_progress');
    c.assistant('Please take your pet to Front Range Pet Emergency at 1200 Larkspur Avenue, Denver right away. If a person is hurt or in danger, call 911.');
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
    expect(c.state.emergencyResult).toBe('cleared');
    expect((await c.delegate([FIND])).results[0]!.ok).toBe(true);
  });

  it('lifts it on "no, forget it, he\'s not hurt" said across pieces of speech, never on "I\'d like an appointment for him"', async () => {
    const c = await w.call('+17205550172', { clinic: refer });
    c.caller('my dog swallowed a sock');
    c.assistant(QUESTION);
    c.caller('Yes');
    c.assistant('Please take your pet to Front Range Pet Emergency right away.');
    c.caller("Okay, but I'd like an appointment for him.");
    expect(c.state.emergencyLocked).toBe(true);
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
    const abroad = { ...refer, phoneNumbers: ['+9771234567'], emergencyNumber: undefined };
    const c = await w.call('+17205550172', { clinic: abroad });
    c.caller('my dog ate rat poison');
    c.assistant(QUESTION);
    const out = instructions(c.caller('yes'));
    expect(out).toContain('call your local emergency number');
    expect(out).not.toContain('112');
  });
});
