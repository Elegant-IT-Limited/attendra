import { PACKS, RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CallState, ResponsesPlanner, simpleTurn } from '../src';
import { world } from './support';

// Riverbend's pets, booking at any hour so a found or added pet can book on the test's clock
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const say = (out: { results: { data: Record<string, unknown> }[] }) => out.results.map((r) => String(r.data.say ?? '')).join(' ');

describe('a pet described before anything is said about being new (a test call, 2026-10-26)', () => {
  it('asks "Is Pepper new to us?" before any lookup, once, and a yes adds the pet', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller("Hi, I'd like to book a check-up for my dog Hazel. She's a one-year-old female, my name is Nora.");
    const first = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Nora', pet_name: 'Hazel', phone: '303 555 0190' } }]);
    expect(first.errors).toEqual(['ask_if_new']);
    expect(say(first)).toContain('"Is Hazel new to us?"');
    expect(c.state.verifyAttempts).toBe(0); // nothing was looked up
    c.assistant('Is Hazel new to us?');
    c.caller('Yes, she is.');
    const again = await c.delegate([
      { tool: 'verify_caller', args: { owner_name: 'Nora', pet_name: 'Hazel', phone: '303 555 0190' } },
      { tool: 'register_patient', args: { pet_name: 'Hazel', owner_name: 'Nora', species: 'dog', sex: 'female', birthday_or_age: 'one year', phone: '303 555 0190' } },
    ]);
    expect(again.errors).toEqual(['pet_is_new', null]);
    expect(again.results[1]!.data.registered).toBe(true);
  });

  it('a no looks the pet up as usual, and the question is never asked twice', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Hi, this is Linh, I want to book Biscuit in. He is a five-year-old male.');
    const first = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit', phone: null } }]);
    expect(first.errors).toEqual(['ask_if_new']);
    c.assistant('Is Biscuit new to us?');
    c.caller("No, he's been there before.");
    const found = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit', phone: null } }]);
    expect(found.errors).toEqual([null]);
    expect(c.state.verifiedPatient?.firstName).toBe('Biscuit');
  });

  it('a caller who only names the pet and the visit is looked up straight away', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller("It's Linh, I'd like a check-up for Biscuit in two weeks.");
    const found = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit', phone: null } }]);
    expect(found.errors).toEqual([null]);
  });

  it('asks in Spanish on a Spanish call', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller('Hola, quiero una cita para mi perra Hazel, tiene un año y es hembra. Me llamo Nora.');
    const first = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Nora', pet_name: 'Hazel', phone: '303 555 0190' } }]);
    expect(first.errors).toEqual(['ask_if_new']);
    expect(say(first)).toContain(`"${PACKS.es.petNewQuestion({ pet: 'Hazel' })}"`);
    // a yes to that question means new, as a yes to "is it new?" does
    c.assistant(PACKS.es.petNewQuestion({ pet: 'Hazel' }));
    c.caller('Sí.');
    expect(c.state.saidNew()).toBe('new');
  });
});

describe('a number from abroad or without its area code is read back once and kept (a test call, 2026-10-26)', () => {
  it('adds the pet with the number as given, reads it back once, and notes it for the team', async () => {
    const created = vi.spyOn(w.backend.tasks, 'create');
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller("My cat Juniper is new, she's two years old and female. I'm Ines, my number is 995 72 124.");
    const added = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Juniper', owner_name: 'Ines', species: 'cat', sex: 'female', birthday_or_age: 'two years', phone: '995 72 124' } }]);
    expect(added.errors).toEqual([null]);
    expect(added.results[0]!.data.registered).toBe(true);
    expect(say(added)).toContain(`"${PACKS.en.phoneAsGiven({ digits: '995 72 124' })}"`);
    expect(say(added)).toContain('never ask for the number again');
    const review = created.mock.calls.map((call) => call[1]).find((t) => t.type === 'review')!;
    expect(review.details.phone).toBe('995 72 124 (as given, may be incomplete)');
    // the same number again is not read back again
    const callback = await c.delegate([{ tool: 'create_callback', args: { reason: 'Questions about Juniper\'s first visit', callback_number: '995 72 124', topic: null } }]);
    expect(callback.errors).toEqual([null]);
    expect(created.mock.calls.at(-1)![1].details.callback_number).toBe('995 72 124 (as given, may be incomplete)');
    created.mockRestore();
  });

  it('never asks again for a number that is short: the lookup goes ahead with it, in the caller\'s language', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller('Hola, soy Linh, llamo por Biscuit.');
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit', phone: '555 0172' } }]);
    expect(out.errors).toEqual(['not_verified']);
    expect(say(out)).toContain(PACKS.es.phoneAsGiven({ digits: '555 0172' }));
    const again = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit', phone: '555 0172' } }]);
    expect(again.errors).not.toContain('phone_required');
    expect(say(again)).not.toContain(PACKS.es.phoneAsGiven({ digits: '555 0172' }));
  });

  it('a whole number is kept as it is, with no note', async () => {
    const created = vi.spyOn(w.backend.tasks, 'create');
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller('Can someone call me back about boarding?');
    await c.delegate([{ tool: 'create_callback', args: { reason: 'Boarding question', callback_number: '(720) 555-0188', topic: null } }]);
    expect(created.mock.calls.at(-1)![1].details.callback_number).toBe('(720) 555-0188');
    created.mockRestore();
  });
});

describe('a caller is never asked to repeat for a mistake of ours', () => {
  it('arguments that do not fit a tool go back to the planner to fix, not to the caller to repeat', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('Can I bring Biscuit in?');
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: 'tomorrow', part_of_day: 'any' } }]);
    expect(out.errors).toEqual(['invalid_arguments']);
    expect(say(out)).toContain('from_date');
    expect(say(out)).not.toMatch(/ask the caller to repeat/i);
  });
});

describe('a caller left waiting gets their own words answered, never "say that again"', () => {
  it('hands the voice what the caller said since it last spoke, without their quotes', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.assistant('How can I help?');
    c.caller('I need to book Hazel, she is "new"');
    c.caller('and my number is 995 72 124');
    const [first] = c.agent.onSilence(1);
    const [second] = c.agent.onSilence(2);
    expect(first).toMatchObject({ type: 'instructions', content: expect.stringContaining('"I need to book Hazel, she is \'new\' and my number is 995 72 124"') });
    expect(first).toMatchObject({ content: expect.stringContaining('Do not ask them to repeat it') });
    expect(second).toMatchObject({ content: expect.stringContaining('Never ask them to repeat it') });
    expect(c.state.silenceNudges).toBe(2);
  });
});

describe('the planner, timed, and faster on simple turns when set up', () => {
  const state = (caller: string) => { const s = new CallState(); s.addTranscript('caller', caller, 0, 900); return s; };

  it('a simple turn is short, with nothing waiting for a yes', () => {
    expect(simpleTurn(state('Biscuit.'))).toBe(true);
    expect(simpleTurn(state('What time do you open tomorrow?'))).toBe(true);
    expect(simpleTurn(state('Hi, I need to book my dog in for his shots and also ask about his diet and maybe a nail trim next week'))).toBe(false);
    expect(simpleTurn(state('Do you open Monday? And Tuesday?'))).toBe(false);
    const yes = state('Yes, book it.');
    yes.pending = { kind: 'book', readback: 'Tuesday at 9', seq: 1, proposedAtMs: 0, readbackAtMs: 100, slot: {} as never, replacesAppointmentId: null };
    expect(simpleTurn(yes)).toBe(false); // a yes books: never the faster setting
  });

  it('sends the configured model and effort for a simple turn only, and reports the model\'s own time', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Sure.' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-main', 8, undefined, { effort: 'medium', simple: { model: 'gpt-fast', effort: 'low' } });
    const c = await w.call('+17205550172', { clinic });
    c.caller('Biscuit.');
    const short = await planner.plan({ clinic, state: c.state, nowLine: '' }, async () => ({ ok: true, data: {} }));
    expect(create.mock.calls[0]![0]).toMatchObject({ model: 'gpt-fast', reasoning: { effort: 'low' } });
    expect(short.timing).toEqual({ model: 'gpt-fast', effort: 'low', simple: true, rounds: 1, modelMs: expect.any(Number) });
    c.caller('and I also want to ask about his diet, his weight, his nails and whether he needs a rabies shot this year or next');
    const long = await planner.plan({ clinic, state: c.state, nowLine: '' }, async () => ({ ok: true, data: {} }));
    expect(create.mock.calls[1]![0]).toMatchObject({ model: 'gpt-main', reasoning: { effort: 'medium' } });
    expect(long.timing).toMatchObject({ model: 'gpt-main', effort: 'medium', simple: false });
  });

  it('unset, every request goes as before: the one model, no reasoning setting', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Sure.' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-main');
    const c = await w.call('+17205550172', { clinic });
    c.caller('Biscuit.');
    const out = await planner.plan({ clinic, state: c.state, nowLine: '' }, async () => ({ ok: true, data: {} }));
    expect(create.mock.calls[0]![0]).not.toHaveProperty('reasoning');
    // still counted as a simple turn, so a run without the faster setting can be compared with one with it
    expect(out.timing).toMatchObject({ model: 'gpt-main', effort: null, simple: true, rounds: 1 });
  });
});
