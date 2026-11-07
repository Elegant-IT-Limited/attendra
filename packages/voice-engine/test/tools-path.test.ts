import { type ActionRecorder, CallAgent, CallState, ScriptedPlanner } from '@attendra/agent';
import { DEMO_CLINIC, localDateOf, PACKS, RIVERBEND_CLINIC, zonedInstant } from '@attendra/core';
import { createLogger } from '@attendra/observability';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CallRunner, fromDelegatedResponse, GO_WAIT_MS, GptLiveEngine, RealtimeEngine, realtimeTools, type RealtimeSocket, type Sideband, type SidebandEvent,
  type SidebandSocket, toolsBackendInstructions, toolsLivePrompt, toolsVoicePrompt, type VoiceEngine, TURN_NOTE, turnNoteFor, sayToolQuestion, toolQuestion, sayToolLine, toolRefusalLine,
} from '../src';

// Batch 1a, the tools path: the voice calls our tools itself (gpt-realtime, path A), or GPT-Live hands each task to a
// Responses model of OpenAI's that calls them (path B). Both arrive at the runner as the same tool call.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const NOW = zonedInstant('2026-09-28', '10:00', DEMO_CLINIC.timezone);
const vet = { ...RIVERBEND_CLINIC, voiceFlow: 'tools' as const };

/** Leaves out the turn notes (batch 1b), to count what else was sent. */
const notNote = (x: Record<string, unknown>) => x.type !== 'conversation.item.delete' && !String((x.item as { id?: string } | undefined)?.id ?? '').startsWith('turn_note_');

describe('the tools-path prompts', () => {
  it('carry tone, language, turn-taking and how to use the tools: no hours, no open or closed, no booking rules', () => {
    const voice = toolsVoicePrompt(vet, { callerNumber: '+17205550172' });
    expect(voice).toContain(vet.greeting);
    expect(voice).toContain('Interruption policy');
    expect(voice).toContain('Call clinic_now before you say anything about the time');
    expect(voice).toContain('ending 0172');
    // nothing the clinic decides is in the prompt: the clock and the rules are the tools'
    for (const policy of [/The \w+ is (open|closed) right now/, /Today the clinic is open/, /While it is closed nothing is booked/, /\bdelegate\b/i, /the backend/]) expect(voice).not.toMatch(policy);
    const live = toolsLivePrompt(vet);
    expect(live).toContain('Delegation policy');
    expect(live).not.toContain('Call clinic_now');
    expect(toolsBackendInstructions(vet)).toContain('Call clinic_now');
    expect(toolsBackendInstructions(vet)).toMatch(/Never mention a tool, a backend/);
  });
});

/** A Realtime call socket that records what it is sent and plays back events. */
function realtimeSocket() {
  const sent: Record<string, unknown>[] = [];
  const handlers: Record<string, ((x: never) => void)[]> = {};
  const ws: RealtimeSocket = {
    send: (e) => { sent.push(e); },
    on: ((event: string, h: (x: never) => void) => { (handlers[event] ??= []).push(h); }) as RealtimeSocket['on'],
    close: vi.fn(),
    socket: { readyState: 1, on: () => undefined } as RealtimeSocket['socket'],
  };
  return { ws, sent, play: (e: Record<string, unknown>) => handlers.event?.forEach((h) => h(e as never)) };
}

describe('path A: gpt-realtime with our tools as its own', () => {
  it('starts a tools-path call with the tools prompt and every tool, and a planner call as before', async () => {
    const calls = { accept: vi.fn(async () => {}) };
    const e = new RealtimeEngine({ realtime: { calls } } as never, 'gpt-realtime-2.1', () => realtimeSocket().ws);
    await e.accept('rtc_1', vet, NOW, undefined, { flow: 'tools', callerNumber: null });
    const session = (calls.accept.mock.calls[0] as unknown[])[1] as { tools: { name: string; strict?: unknown }[]; instructions: string };
    expect(session.tools.map((t) => t.name)).toEqual(realtimeTools(vet).map((t) => t.name));
    expect(session.tools.map((t) => t.name)).toContain('clinic_now');
    expect(session.tools.every((t) => !('strict' in t))).toBe(true);
    expect(session.instructions).toContain('How you work');
    await e.accept('rtc_2', vet, NOW, undefined, { flow: 'planner' });
    expect(((calls.accept.mock.calls[1] as unknown[])[1] as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['ask_backend']);
  });

  it('passes a tool call on, and goes on only once every call of the response has its result', async () => {
    const s = realtimeSocket();
    const e = new RealtimeEngine({ realtime: { calls: { accept: vi.fn(async () => {}) } } } as never, 'gpt-realtime-2.1', () => s.ws);
    await e.accept('rtc_1', vet, NOW, undefined, { flow: 'tools' });
    const sideband = e.attach('rtc_1');
    const seen: SidebandEvent[] = [];
    sideband.onEvent((ev) => seen.push(ev));
    s.play({ type: 'response.created', event_id: 'r1' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'a', name: 'clinic_now', call_id: 'fc_1', arguments: '{}' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'b', name: 'find_slots', call_id: 'fc_2', arguments: '{"visit_type_id":"vt_wellness"}' });
    s.play({ type: 'response.done', event_id: 'r2' });
    expect(seen).toEqual([
      { type: 'session.tool_call', event_id: 'a', call_id: 'fc_1', name: 'clinic_now', arguments: '{}' },
      { type: 'session.tool_call', event_id: 'b', call_id: 'fc_2', name: 'find_slots', arguments: '{"visit_type_id":"vt_wellness"}' },
    ]);
    const before = s.sent.length;
    sideband.send({ type: 'tool.result', event_id: 't1', call_id: 'fc_1', output: '{"ok":true}' });
    expect(s.sent.slice(before)).toEqual([{ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'fc_1', output: '{"ok":true}' } }]);
    sideband.send({ type: 'tool.result', event_id: 't2', call_id: 'fc_2', output: '{"ok":true}' });
    expect(s.sent.slice(before).map((x) => x.type)).toEqual(['conversation.item.create', 'conversation.item.create', 'response.create']);
  });

  it('says a tool\'s own question as written, with no tools in that reply (batch 1c: a live run dropped "Shall I look with them?")', async () => {
    const s = realtimeSocket();
    const e = new RealtimeEngine({ realtime: { calls: { accept: vi.fn(async () => {}) } } } as never, 'gpt-realtime-2.1', () => s.ws);
    await e.accept('rtc_q', vet, NOW, undefined, { flow: 'tools' });
    const sideband = e.attach('rtc_q');
    s.play({ type: 'response.created', event_id: 'r1' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'a', name: 'find_slots', call_id: 'fc_1', arguments: '{}' });
    s.play({ type: 'response.done', event_id: 'r2' });
    const line = 'Dr. Mara Vance doesn\'t do dental care. Dr. Omar Rahman and Dr. Leila Khan do dental care. Shall I look with them?';
    const before = s.sent.length;
    sideband.send({ type: 'tool.result', event_id: 't1', call_id: 'fc_1', output: JSON.stringify({ ok: true, outcome: 'no_times', spoken: line, data: {} }) });
    expect(s.sent.slice(before).at(-1)).toEqual({ type: 'response.create', response: { instructions: sayToolQuestion(line), tool_choice: 'none' } });
    expect(toolQuestion(JSON.stringify({ spoken: 'I have 9:00 or 9:20.' }))).toBeNull();
    expect(toolQuestion('not json')).toBeNull();
  });

  it('says a tool\'s refusal line word for word; a question still wins (batch 1d: "no trabaja los martes" paraphrased)', async () => {
    const s = realtimeSocket();
    const e = new RealtimeEngine({ realtime: { calls: { accept: vi.fn(async () => {}) } } } as never, 'gpt-realtime-2.1', () => s.ws);
    await e.accept('rtc_r', vet, NOW, undefined, { flow: 'tools' });
    const sideband = e.attach('rtc_r');
    s.play({ type: 'response.created', event_id: 'r1' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'a', name: 'verify_caller', call_id: 'fc_1', arguments: '{}' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'b', name: 'find_slots', call_id: 'fc_2', arguments: '{}' });
    s.play({ type: 'response.done', event_id: 'r2' });
    const line = 'Dra. Mara Vance no trabaja los martes. Atiende los viernes y los domingos.';
    const before = s.sent.length;
    sideband.send({ type: 'tool.result', event_id: 't1', call_id: 'fc_1', output: JSON.stringify({ verified: true, say: 'Say first, in these words: "Gracias, Jordan."' }) });
    sideband.send({ type: 'tool.result', event_id: 't2', call_id: 'fc_2', output: JSON.stringify({ slots: [], say_as: line, reason: 'not_working_that_day', note: 'x' }) });
    expect(s.sent.slice(before).at(-1)).toEqual({ type: 'response.create', response: { instructions: sayToolLine(line), tool_choice: 'none' } });
    expect(sayToolLine(line)).toContain('comes before it');
    // a refusal's own "Say, in these words"
    expect(toolRefusalLine(JSON.stringify({ error: 'staff_books', say: 'Say, in these words: "The team books surgery." A request: create_callback.' }))).toBe('The team books surgery.');
    // times with no reason, a visit the vet doesn't do (said only if the caller named it), and plain results are not
    expect(toolRefusalLine(JSON.stringify({ slots: [{}], say_as: 'On Friday I have 9:00.' }))).toBeNull();
    expect(toolRefusalLine(JSON.stringify({ slots: [], say_as: 'Dr. Vance does not do wellness exams.', reason: 'doesnt_do_type' }))).toBeNull();
    expect(toolRefusalLine('not json')).toBeNull();
    // a question and a refusal line in one response: the question
    s.play({ type: 'response.created', event_id: 'r3' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'c', name: 'find_slots', call_id: 'fc_3', arguments: '{}' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'd', name: 'propose_booking', call_id: 'fc_4', arguments: '{}' });
    s.play({ type: 'response.done', event_id: 'r4' });
    const ask = 'I have Friday at 9:00 AM. Shall I book it?';
    sideband.send({ type: 'tool.result', event_id: 't3', call_id: 'fc_3', output: JSON.stringify({ slots: [], say_as: line, reason: 'fully_booked' }) });
    sideband.send({ type: 'tool.result', event_id: 't4', call_id: 'fc_4', output: JSON.stringify({ spoken: ask }) });
    expect(s.sent.at(-1)).toEqual({ type: 'response.create', response: { instructions: sayToolQuestion(ask), tool_choice: 'none' } });
  });
});

/** GPT-Live's sideband socket: what it is sent, and events played back. */
function liveSocket() {
  const sent: Record<string, unknown>[] = [];
  const handlers: Record<string, ((x: never) => void)[]> = {};
  const ws = {
    send: (e: unknown) => { sent.push(e as Record<string, unknown>); },
    on: (event: string, h: (x: never) => void) => { (handlers[event] ??= []).push(h); return ws; },
    close: vi.fn(),
    socket: { readyState: 1, on: () => undefined },
  } as unknown as SidebandSocket;
  return { ws, sent, play: (e: Record<string, unknown>) => handlers.event?.forEach((h) => h(e as never)) };
}

describe('path A: what waits for the caller\'s words', () => {
  it('runs a lookup at once, and holds a write until the caller\'s words before it are transcribed', async () => {
    const s = realtimeSocket();
    const e = new RealtimeEngine({ realtime: { calls: { accept: vi.fn(async () => {}) } } } as never, 'gpt-realtime-2.1', () => s.ws);
    await e.accept('rtc_1', vet, NOW, undefined, { flow: 'tools' });
    const sideband = e.attach('rtc_1');
    const seen: string[] = [];
    sideband.onEvent((ev) => seen.push(ev.type === 'session.tool_call' ? (ev as { name: string }).name : ev.type));
    s.play({ type: 'input_audio_buffer.committed', event_id: 'c1', item_id: 'item_1' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'a', name: 'find_slots', call_id: 'fc_1', arguments: '{}' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'b', name: 'commit_pending', call_id: 'fc_2', arguments: '{}' });
    expect(seen).toEqual(['find_slots']);
    s.play({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'd', item_id: 'item_1', transcript: 'Yes, book it.' });
    expect(seen).toEqual(['find_slots', 'session.input_transcript.delta', 'commit_pending']);
  });
});

describe('round 2: manual replies on gpt-realtime', () => {
  it('puts one note after each caller turn (the voice says only what a tool gives it), and removes the last one', async () => {
    const s = realtimeSocket();
    const e = new RealtimeEngine({ realtime: { calls: { accept: vi.fn(async () => {}) } } } as never, 'gpt-realtime-2.1', () => s.ws);
    await e.accept('rtc_n', vet, NOW, undefined, { flow: 'tools' });
    e.attach('rtc_n');
    s.play({ type: 'response.done', event_id: 'r0' });
    const start = s.sent.length;
    s.play({ type: 'input_audio_buffer.committed', event_id: 'c0', item_id: 'item_0' });
    expect(s.sent.slice(start)).toEqual([
      { type: 'conversation.item.create', item: { id: 'turn_note_1', type: 'message', role: 'system', content: [{ type: 'input_text', text: turnNoteFor(vet, NOW) }] } },
      { type: 'response.create' },
    ]);
    expect(TURN_NOTE).toContain('with no words before it');
    // the clinic's date, so "Thursday" is this week's (batch 1c)
    expect(turnNoteFor(vet, NOW)).toContain(`Today at the clinic is ${PACKS.en.fullDay(localDateOf(NOW, vet.timezone))}`);
    s.play({ type: 'response.done', event_id: 'r1' });
    const next = s.sent.length;
    s.play({ type: 'input_audio_buffer.committed', event_id: 'c1', item_id: 'item_1' });
    expect(s.sent.slice(next).map((x) => x.type)).toEqual(['conversation.item.delete', 'conversation.item.create', 'response.create']);
    expect(s.sent[next]).toEqual({ type: 'conversation.item.delete', item_id: 'turn_note_1' });
  });

  it('waits for the go after a turn, takes the lookup handed to it, and replies once; by itself if no go comes', async () => {
    vi.useFakeTimers();
    const s = realtimeSocket();
    const e = new RealtimeEngine({ realtime: { calls: { accept: vi.fn(async () => {}) } } } as never, 'gpt-realtime-2.1', () => s.ws);
    await e.accept('rtc_1', vet, NOW, undefined, { flow: 'tools' });
    const sideband = e.attach('rtc_1');
    s.play({ type: 'response.done', event_id: 'r0' }); // the greeting's reply is over
    // before a pet is found, a turn gets its reply at once
    const start = s.sent.length;
    s.play({ type: 'input_audio_buffer.committed', event_id: 'c0', item_id: 'item_0' });
    expect(s.sent.slice(start).filter(notNote).map((x) => x.type)).toEqual(['response.create']);
    s.play({ type: 'response.done', event_id: 'r00' });
    sideband.send({ type: 'turns.manual', event_id: 'm1', on: true });
    const before = s.sent.length;
    s.play({ type: 'input_audio_buffer.committed', event_id: 'c1', item_id: 'item_1' });
    sideband.send({ type: 'tool.inject', event_id: 'i1', call_id: 'spec_1', name: 'find_slots', arguments: '{}', output: '{"ok":true}' });
    sideband.send({ type: 'reply.go', event_id: 'g1' });
    expect(s.sent.slice(before).filter(notNote).map((x) => (x.item as { type?: string } | undefined)?.type ?? x.type)).toEqual(['function_call', 'function_call_output', 'response.create']);
    // a second go for the same turn does nothing; a turn with no go replies by itself
    sideband.send({ type: 'reply.go', event_id: 'g2' });
    s.play({ type: 'response.done', event_id: 'r1' });
    const mid = s.sent.length;
    s.play({ type: 'input_audio_buffer.committed', event_id: 'c2', item_id: 'item_2' });
    vi.advanceTimersByTime(GO_WAIT_MS);
    expect(s.sent.slice(mid).filter(notNote).map((x) => x.type)).toEqual(['response.create']);
    // a lookup handed over after it already replied by itself is dropped
    sideband.send({ type: 'tool.inject', event_id: 'i2', call_id: 'spec_2', name: 'find_slots', arguments: '{}', output: '{}' });
    expect(s.sent.slice(mid).filter(notNote)).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('path B: GPT-Live with a Responses backend running our tools', () => {
  it('starts the session with Responses delegation: the backend model, its instructions and our tools', async () => {
    const sessions = { accept: vi.fn(async () => {}) };
    const e = new GptLiveEngine({ live: { sessions } } as never, 'gpt-live-1', () => liveSocket().ws, { model: 'gpt-6-luna', effort: 'low', tier: 'priority' });
    await e.accept('live_1', vet, NOW, undefined, { flow: 'tools', callerNumber: '+17205550172' });
    const { session } = (sessions.accept.mock.calls[0] as unknown[])[1] as { session: { delegation: { type: string; responses: { model: string; tools: { name: string }[]; reasoning: unknown; service_tier: string; instructions: string } }; instructions: string; store: boolean } };
    expect(session.delegation.type).toBe('responses');
    expect(session.delegation.responses).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'low' }, service_tier: 'priority' });
    expect(session.delegation.responses.tools.map((t) => t.name)).toContain('commit_pending');
    expect(session.delegation.responses.instructions).toContain('How you work');
    expect(session.store).toBe(false);
    await e.accept('live_2', vet, NOW);
    expect(((sessions.accept.mock.calls[1] as unknown[])[1] as { session: { delegation: { type: string } } }).session.delegation).toEqual({ type: 'client' });
  });

  it('reads our tool calls and the backend\'s tokens out of the delegated stream, and continues it with the results', async () => {
    const s = liveSocket();
    const e = new GptLiveEngine({ live: { sessions: { accept: vi.fn(async () => {}) } } } as never, 'gpt-live-1', () => s.ws);
    await e.accept('live_1', vet, NOW, undefined, { flow: 'tools' });
    const sideband = e.attach('live_1');
    const seen: SidebandEvent[] = [];
    sideband.onEvent((ev) => seen.push(ev));
    s.play({ type: 'response.event', event_id: 'x1', delegation_id: 'd1', event: { type: 'response.output_text.delta', delta: 'Let' } });
    s.play({ type: 'response.event', event_id: 'x2', delegation_id: 'd1', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'clinic_now', arguments: '{}' } } });
    s.play({ type: 'response.event', event_id: 'x3', delegation_id: 'd1', event: { type: 'response.completed', response: { model: 'gpt-6-luna', usage: { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 600 } } } } });
    s.play({ type: 'session.output_transcript.delta', event_id: 'x4', delta: 'It is ten.', start_ms: 1, end_ms: 2 });
    expect(seen).toEqual([
      { type: 'session.tool_call', event_id: 'x2', call_id: 'call_1', name: 'clinic_now', arguments: '{}' },
      { type: 'session.model_usage', event_id: 'x3', model: 'gpt-6-luna', input: 900, cached: 600, output: 40 },
      { type: 'session.output_transcript.delta', event_id: 'x4', delta: 'It is ten.', start_ms: 1, end_ms: 2 },
    ]);
    sideband.send({ type: 'tool.result', event_id: 't1', call_id: 'call_1', output: '{"ok":true}' });
    expect(s.sent).toEqual([
      { type: 'response.item.create', event_id: 't1', item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' } },
      { type: 'response.create', event_id: 't1_go' },
    ]);
    expect(fromDelegatedResponse({ event_id: 'y', event: { type: 'response.output_item.done', item: { type: 'message' } } })).toBeNull();
  });
});

describe('the runner on the tools path', () => {
  function harness() {
    const sent: unknown[] = [];
    const engine = { name: 'fake', accept: vi.fn(), startBrowserCall: vi.fn(), reject: vi.fn(), attach: vi.fn(), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}) } satisfies VoiceEngine;
    const sideband: Sideband = { send: (e) => sent.push(e), onEvent: () => {}, onError: () => {}, onClose: () => {}, close: vi.fn() };
    const actions: { tool: string; result: unknown }[] = [];
    const recorder: ActionRecorder = { record: async (a) => { actions.push({ tool: a.tool, result: a.result }); } };
    const backend = { patients: {}, scheduler: { busy: vi.fn(async () => []) }, tasks: {}, audit: { record: vi.fn(async () => {}) }, messenger: { sendTemplate: vi.fn() } };
    const agent = new CallAgent(new CallState(), { clinic: DEMO_CLINIC, callId: 'call_1', callerNumber: null, now: () => NOW }, backend as never, new ScriptedPlanner([]), log, recorder);
    const closes: { usage?: unknown }[] = [];
    const runner = new CallRunner('rtc_1', engine, sideband, agent, { appendSegment: async () => {}, close: async (c) => { closes.push(c); } }, log);
    return { runner, sent, actions, agent, closes };
  }
  const say = (type: 'in' | 'out', id: string, text: string, at: number): SidebandEvent => ({
    type: type === 'in' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', event_id: id, delta: text, start_ms: at, end_ms: at + 400,
  });

  it('answers a tool call with the tool\'s result, once, and times the answer from the caller\'s words to the first words after it', async () => {
    const h = harness();
    await h.runner.handle(say('in', 'e1', 'What time is it there?', 1000)); // ends at 1400
    await h.runner.handle(say('out', 'e2', 'Let me check.', 1600)); // before the result: not the answer
    await h.runner.handle({ type: 'session.tool_call', event_id: 'e3', call_id: 'fc_1', name: 'clinic_now', arguments: '{}' });
    await h.runner.handle({ type: 'session.tool_call', event_id: 'e3b', call_id: 'fc_1', name: 'clinic_now', arguments: '{}' }); // a replay
    expect(h.sent).toHaveLength(1);
    const result = h.sent[0] as { type: string; call_id: string; output: string };
    expect(result).toMatchObject({ type: 'tool.result', call_id: 'fc_1' });
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, outcome: 'ok', data: { zone: DEMO_CLINIC.timezone } });
    await h.runner.handle(say('out', 'e4', 'It\'s 10 AM here in Denver.', 2300));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.actions.filter((a) => a.tool === 'answer_timing')).toEqual([{ tool: 'answer_timing', result: { wait_ms: 900, tools: 1, flow: 'tools' } }]);
  });

  it('refuses arguments that are not JSON without running anything', async () => {
    const h = harness();
    await h.runner.handle({ type: 'session.tool_call', event_id: 'e1', call_id: 'fc_9', name: 'find_slots', arguments: '{oops' });
    expect(JSON.parse((h.sent[0] as { output: string }).output)).toMatchObject({ ok: false, outcome: 'invalid_arguments' });
  });

  it('once the pet is found, runs the lookup the caller asks for, hands it over, then says go', async () => {
    const h = harness();
    h.runner.manualTurns = true;
    h.agent.state.verifiedPatient = { id: 'p1', firstName: 'Biscuit' } as never;
    h.agent.state.memory.set('visitType', 'vt_annual', 'tool');
    // times are on the table: the next turn may ask for another
    h.agent.state.offered.set('prov_okafor@x', { id: 'prov_okafor@x', providerId: 'prov_okafor', start: new Date(), end: new Date(), visitTypeId: 'vt_annual' } as never);
    await h.runner.handle({ type: 'session.tool_call', event_id: 't0', call_id: 'fc_0', name: 'clinic_now', arguments: '{}' });
    expect(h.sent).toContainEqual(expect.objectContaining({ type: 'turns.manual', on: true }));
    h.sent.length = 0;
    await h.runner.handle(say('in', 'e1', 'What about Friday morning?', 5000));
    expect(h.sent.map((x) => (x as { type: string }).type)).toEqual(['tool.inject', 'reply.go']);
    expect(h.sent[0]).toMatchObject({ name: 'find_slots' });
    h.sent.length = 0;
    // nothing to look up: just the go
    await h.runner.handle(say('out', 'e1b', 'Friday at 9 or 10?', 7000));
    await h.runner.handle(say('in', 'e2', 'Thanks.', 9000));
    expect(h.sent.map((x) => (x as { type: string }).type)).toEqual(['reply.go']);
  });

  it('counts the delegated model\'s tokens toward the call\'s cost row', async () => {
    const h = harness();
    await h.runner.handle({ type: 'session.model_usage', event_id: 'u1', model: 'gpt-6-luna', input: 900, cached: 600, output: 40 });
    await h.runner.handle({ type: 'session.model_usage', event_id: 'u2', model: 'gpt-6-luna', input: 100, cached: 0, output: 10 });
    await h.runner.handle({ type: 'session.closed', event_id: 'c1', reason: 'remote_hangup', usage: { seconds: 30 } });
    expect(h.closes[0]!.usage).toEqual({ models: { 'gpt-6-luna': { input: 1000, cached: 600, output: 50 } }, fastTier: false });
  });
});
