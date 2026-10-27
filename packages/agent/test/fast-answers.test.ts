// The backend's own words as the whole answer: a tool that did the thing and wrote the sentence for it is spoken as it
// is, with no further model round (2026-11). Nothing is ever spoken as done before the tool returned ok.
import { DEMO_CLINIC, localDateOf, localParts } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Outbound, ResponsesPlanner, type ToolResult } from '../src';
import { textingOn, world } from './support';

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); }, 60_000);
afterAll(() => w.t.close());

const commentary = (out: Outbound[]) => out.flatMap((o) => (o.type === 'commentary' ? [o.content] : [])).join(' ');
const call = (name: string, args: unknown = {}) => ({ type: 'function_call', name, call_id: `c_${name}`, arguments: JSON.stringify(args) });
const maria = { tool: 'verify_caller' as const, args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985' } };
const sick = (extra: Record<string, unknown> = {}) => ({ tool: 'find_slots' as const, args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any', ...extra } });

describe('the planner speaks the tool\'s own sentence and stops', () => {
  it('one ok call with a spoken line: said as it is, one model round', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [call('end_call', { reason: 'goodbye' })], output_text: '' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-test');
    const c = await w.call();
    c.assistant('Is there anything else I can help you with?');
    c.caller('No, that\'s all. Bye!');
    const out = await c.delegate([], planner);
    expect(create).toHaveBeenCalledTimes(1);
    expect(commentary(out)).toBe('Take care, goodbye!');
    expect(out.some((o) => o.type === 'hangup')).toBe(true);
  });

  it('a refusal, a lookup, or two calls at once go back to the model as before', async () => {
    const c = await w.call();
    c.caller('Thanks, that\'s it.');
    // end_call refused (nothing asked yet, and the caller did not say goodbye themselves): the model hears the refusal and answers
    let create = vi.fn(async (..._args: unknown[]) => (create.mock.calls.length === 1 ? { output: [call('end_call', { reason: 'goodbye' })], output_text: '' } : { output: [], output_text: 'Is there anything else I can help you with?' }));
    const out = await c.delegate([], new ResponsesPlanner({ responses: { create } } as never, 'gpt-test'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(commentary(out)).toBe('Is there anything else I can help you with?');
    // a lookup has no sentence of its own
    create = vi.fn(async (..._args: unknown[]) => (create.mock.calls.length === 1 ? { output: [call('verify_caller', maria.args)], output_text: '' } : { output: [], output_text: 'Found you, Maria.' }));
    await c.delegate([], new ResponsesPlanner({ responses: { create } } as never, 'gpt-test'));
    expect(create).toHaveBeenCalledTimes(2);
    // two tools in one round: the model puts the two results together
    let calls = 0;
    const execute = async (): Promise<ToolResult> => ({ ok: true, data: { spoken: `Line ${++calls}.` } });
    const model = { responses: { create: vi.fn(async (..._args: unknown[]) => (model.responses.create.mock.calls.length === 1 ? { output: [call('send_text'), call('end_call')], output_text: '' } : { output: [], output_text: 'Both done.' })) } };
    const two = await new ResponsesPlanner(model as never, 'gpt-test').plan({ clinic: DEMO_CLINIC, state: c.state, nowLine: '' }, execute);
    expect(two.say).toBe('Both done.');
    expect(model.responses.create).toHaveBeenCalledTimes(2);
  });
});

describe('the sentences the tools write', () => {
  it('a booking is read back as a question, booked only after the yes, then the closing question', async () => {
    const c = await w.call('+13035550147', { clinic: textingOn(DEMO_CLINIC) });
    c.caller('Maria Delgado, March 4th 1985. I need a sick visit, any doctor, first time you have.');
    const out = await c.delegate([maria, sick(), { tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null }) }]);
    const proposed = out.results[2]!.data as { spoken: string; say: string };
    expect(proposed.spoken).toMatch(/^I have .+ with Dr\. .+ for a sick visit\. I'll text you a confirmation at the number (on file|you're calling from), unless you'd rather not\. Shall I book it\?$/);
    expect(c.state.pending?.kind).toBe('book');
    // the yes
    c.assistant(proposed.spoken);
    c.caller('Yes please.');
    const booked = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(booked.results[0]!.data).toMatchObject({ booked: true, spoken: 'All set, that\'s booked. I\'ve sent you a confirmation text. Is there anything else I can help you with?' });
    expect(c.state.outcome).toBe('booked');
  });

  it('a booking that is refused has no sentence to speak', async () => {
    const c = await w.call();
    c.caller('Maria Delgado, March 4th 1985. Book me Thursday.');
    const out = await c.delegate([maria, { tool: 'propose_booking', args: { slot_id: 'slot_made_up', replaces_appointment_id: null } }]);
    expect(out.results[1]!.ok).toBe(false);
    expect(out.results[1]!.data).not.toHaveProperty('spoken');
    expect(c.state.pending).toBeNull();
  });

  it('end_call keeps its rule: refused until "anything else?" was asked and answered with a no or a goodbye', async () => {
    const c = await w.call();
    c.caller('Thanks, that\'s it.');
    const early = await c.delegate([{ tool: 'end_call', args: { reason: 'goodbye' } }]);
    expect(early.errors).toEqual(['caller_not_finished']);
    expect(early.results[0]!.data).not.toHaveProperty('spoken');
    c.assistant('Is there anything else I can help you with?');
    c.caller('No, that\'s all.');
    const done = await c.delegate([{ tool: 'end_call', args: { reason: 'goodbye' } }]);
    expect(done.errors).toEqual([null]);
    expect(done.results[0]!.data).toMatchObject({ ending: true, spoken: 'Take care, goodbye!' });
  });

  it('a callback says which number the team will call, and asks what else', async () => {
    const c = await w.call('+13035550147');
    c.caller('Can someone call me back about my bill?');
    const mine = await c.delegate([{ tool: 'create_callback', args: { reason: 'Billing question', callback_number: null, topic: null } }]);
    expect(mine.results[0]!.data).toMatchObject({ spoken: 'Okay, I\'ve passed that on to the team, and someone will call you back at this number. Is there anything else I can help you with?' });
    const other = await w.call('+13035550147');
    other.caller('Call me back on 303 555 0199 please.');
    const given = await other.delegate([{ tool: 'create_callback', args: { reason: 'Billing question', callback_number: '303 555 0199', topic: null } }]);
    expect((given.results[0]!.data as { spoken: string }).spoken).toContain('at the number you gave me');
  });

  it('in Spanish, the same lines in Spanish, usted', async () => {
    const c = await w.call('+13035550147', { clinic: textingOn(DEMO_CLINIC) });
    c.caller('Hola, soy Maria Delgado, cuatro de marzo de 1985. Necesito una consulta por enfermedad, con cualquier doctor.');
    const out = await c.delegate([maria, sick(), { tool: 'propose_booking', args: () => ({ slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null }) }]);
    const proposed = out.results[2]!.data as { spoken: string };
    expect(proposed.spoken).toMatch(/^Tengo .+\. Le enviaré una confirmación por mensaje de texto al número (de su ficha|desde el que llama), si le parece bien\. ¿Le reservo la cita\?$/);
    c.assistant(proposed.spoken);
    c.caller('Sí, por favor.');
    const booked = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(booked.results[0]!.data).toMatchObject({ spoken: 'Listo, la cita queda reservada. Le he enviado un mensaje de confirmación. ¿Hay algo más en lo que le pueda ayudar?' });
    c.assistant('¿Hay algo más en lo que le pueda ayudar?');
    c.caller('No, eso es todo. Adiós.');
    const bye = await c.delegate([{ tool: 'end_call', args: { reason: 'goodbye' } }]);
    expect(bye.results[0]!.data).toMatchObject({ spoken: 'Que le vaya bien. ¡Adiós!' });
  });
});

describe('find_slots stages the exact time the caller named', () => {
  /** The first free sick-visit time, as a date and a time of day in the clinic's zone. */
  async function firstFree() {
    const c = await w.call();
    c.caller('Maria Delgado, March 4th 1985. When can I come in for a sick visit?');
    await c.delegate([maria, sick()]);
    const slot = [...c.state.offered.values()][0]!;
    const local = localParts(slot.start, DEMO_CLINIC.timezone);
    return { date: localDateOf(slot.start, DEMO_CLINIC.timezone), time: `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}` };
  }

  it('verified, and the exact time is free: it is proposed in the same call and read back', async () => {
    const { date, time } = await firstFree();
    const c = await w.call();
    c.caller(`Maria Delgado, March 4th 1985. Can I come in on ${date} at ${time} for a sick visit?`);
    const out = await c.delegate([maria, sick({ from_date: date, from_time: time, propose_if_exact: true })]);
    expect(out.errors).toEqual([null, null]);
    const data = out.results[1]!.data as { slots: unknown[]; proposed_slot_id?: string; spoken?: string };
    expect(data.proposed_slot_id).toBeDefined();
    expect(data.spoken).toMatch(/Shall I book it\?$/);
    expect(c.state.pending).toMatchObject({ kind: 'book', slot: { id: data.proposed_slot_id } });
    expect(c.state.outcome).not.toBe('booked');
  });

  it('not verified, or not that exact time: only the times come back, nothing is staged', async () => {
    const { date, time } = await firstFree();
    const anon = await w.call();
    anon.caller(`Can I come in on ${date} at ${time} for a sick visit?`);
    const out = await anon.delegate([sick({ from_date: date, from_time: time, propose_if_exact: true })]);
    expect(out.results[0]!.data).not.toHaveProperty('proposed_slot_id');
    expect(anon.state.pending).toBeNull();
    const c = await w.call();
    c.caller(`Maria Delgado, March 4th 1985. Can I come in on ${date} at 03:07 for a sick visit?`);
    const off = await c.delegate([maria, sick({ from_date: date, from_time: '03:07', propose_if_exact: true })]);
    expect(off.results[1]!.data).not.toHaveProperty('proposed_slot_id');
    expect((off.results[1]!.data as { slots: unknown[] }).slots.length).toBeGreaterThan(0);
    expect(c.state.pending).toBeNull();
  });
});

describe('a request the prompt cache can reuse', () => {
  const body = (create: ReturnType<typeof vi.fn>, i: number) => create.mock.calls[i]![0] as { instructions: string; tools: unknown; input: { content: string }[]; prompt_cache_key: string; service_tier?: string };

  it('the rules and tools are byte-identical across turns and minutes; the clock and the state come last; fixed notes come before the transcript', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Sure.' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-main');
    const c = await w.call('+13035550147', { history: 'Name on file for this number: Maria.' });
    c.caller('Hi, it\'s Maria.');
    await planner.plan({ clinic: DEMO_CLINIC, state: c.state, nowLine: 'Today is Monday, 2026-09-28, 20:14 clinic time. The clinic is closed today.', callerNumber: '+13035550147', history: 'Name on file for this number: Maria.' }, async () => ({ ok: true, data: {} }));
    c.assistant('Hi Maria, how can I help?');
    c.caller('I need a sick visit.');
    await planner.plan({ clinic: DEMO_CLINIC, state: c.state, nowLine: 'Today is Monday, 2026-09-28, 20:15 clinic time. The clinic is closed today.', callerNumber: '+13035550147', history: 'Name on file for this number: Maria.' }, async () => ({ ok: true, data: {} }));
    const [a, b] = [body(create, 0), body(create, 1)];
    expect(a.instructions).toBe(b.instructions);
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(a.instructions).toContain('Today is Monday, 2026-09-28. The clinic is closed today.');
    expect(a.instructions).not.toContain('20:14');
    expect(a.input[0]!.content).toMatch(/The time now: 20:14 clinic time\.$/);
    expect(b.input[0]!.content).toMatch(/The time now: 20:15 clinic time\.$/);
    // the fixed notes open the message, and the second request's message starts with the first's
    expect(a.input[0]!.content.startsWith('Our records for the number this caller is calling from')).toBe(true);
    const upTo = (s: string) => s.slice(0, s.indexOf('Caller: Hi, it\'s Maria.') + 'Caller: Hi, it\'s Maria.'.length);
    expect(upTo(b.input[0]!.content)).toBe(upTo(a.input[0]!.content));
    expect(a.prompt_cache_key).toBe(DEMO_CLINIC.id);
    expect(a).not.toHaveProperty('service_tier');
  });

  it('a processing tier, when set, goes on every round and the one served is recorded', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Sure.', service_tier: 'priority' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-main', 8, undefined, { tier: 'fast' });
    const c = await w.call();
    c.caller('Maria Delgado.');
    const out = await planner.plan({ clinic: DEMO_CLINIC, state: c.state, nowLine: '' }, async () => ({ ok: true, data: {} }));
    expect(body(create, 0).service_tier).toBe('fast');
    expect(out.timing).toMatchObject({ tier: 'fast', requests: [{ served: 'priority' }] });
  });
});
