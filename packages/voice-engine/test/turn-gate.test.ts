import { type CallEventInput, DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeEngine, type RealtimeSocket, TurnGate } from '../src';

// Foundation A, item 3: the Realtime turn gate. Before, one `active` flag was cleared only by response.done, so an error
// (a refused response.create) left it set and nothing spoke until the runner's nudge; and one `wanted` slot meant the
// last request won, so a no-tools line could replace a reply that needed tools.

const NOW = zonedInstant('2026-09-28', '10:00', DEMO_CLINIC.timezone);
const REPLY = { type: 'response.create' };
const SAY = { type: 'response.create', response: { tool_choice: 'none' } };
const HOLD = { type: 'response.create', response: { instructions: 'Say only "One moment."', tool_choice: 'none' } };
const GREETING = { type: 'response.create', response: { instructions: 'Greet the caller.', tool_choice: 'none' } };

function socket() {
  const sent: Record<string, unknown>[] = [];
  const handlers: ((x: never) => void)[] = [];
  const ws: RealtimeSocket = {
    send: (e) => { sent.push(e); },
    on: ((event: string, h: (x: never) => void) => { if (event === 'event') handlers.push(h); }) as RealtimeSocket['on'],
    close: vi.fn(),
    socket: { readyState: 1, on: () => undefined } as RealtimeSocket['socket'],
  };
  return { ws, sent, play: (e: Record<string, unknown>) => handlers.forEach((h) => h(e as never)) };
}

/** A planner-path call, its greeting already done: what it sends from here, and its event log. */
function call() {
  const s = socket();
  const e = new RealtimeEngine({ realtime: { calls: { accept: vi.fn(async () => {}) } } } as never, 'gpt-realtime-2.1', () => s.ws);
  void e.accept('rtc_gate', DEMO_CLINIC, NOW);
  const sideband = e.attach('rtc_gate');
  const log: CallEventInput[] = [];
  sideband.onTrace!((x) => log.push(x));
  s.play({ type: 'response.done', event_id: 'greeted', response: { id: 'resp_greeting' } });
  s.sent.length = 0;
  log.length = 0;
  const answer = (id: string, content: string) => sideband.send({ type: 'session.commentary.append', event_id: id, delegation_id: id, content });
  const creates = () => s.sent.filter((x) => x.type === 'response.create');
  return { s, sideband, log, answer, creates, gates: () => log.filter((x) => x.type.startsWith('gate.')).map((x) => x.type) };
}

describe('the turn gate: an error that means nothing is running clears it', () => {
  it('error while active: a refused response.create lets the next request go at once, instead of waiting for a nudge', () => {
    const c = call();
    c.answer('fc_1', 'Tuesday at 9 is free.');
    expect(c.creates()).toHaveLength(1);
    // the backend's next answer arrives while that create is in flight: it waits
    c.answer('fc_2', 'Biscuit is found.');
    expect(c.creates()).toHaveLength(1);
    // the create is refused before any response started: nothing is running, so the waiting request goes now
    c.s.play({ type: 'error', event_id: 'e1', error: { type: 'invalid_request_error', code: 'invalid_value', message: 'Invalid value' } });
    expect(c.creates()).toHaveLength(2);
    expect(c.gates()).toEqual(['gate.sent.reply', 'gate.queued.reply', 'gate.cleared_on_error', 'gate.sent.reply']);
    // and the provider's error is in the log with its code and type only
    expect(c.log.find((x) => x.type === 'error')).toEqual({ type: 'error', responseId: null, itemId: null, errorCode: 'invalid_value', errorType: 'invalid_request_error' });
    expect(JSON.stringify(c.log)).not.toContain('Invalid value');
  });

  it('a create refused because a response is already running goes again when that response is done', () => {
    const c = call();
    c.answer('fc_1', 'Tuesday at 9 is free.');
    // the server's turn detection had started a reply of its own: ours is refused
    c.s.play({ type: 'response.created', event_id: 'r1', response: { id: 'resp_auto' } });
    c.s.play({ type: 'error', event_id: 'e1', error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response', message: 'Conversation already has an active response in progress: resp_auto.' } });
    expect(c.creates()).toHaveLength(1);
    c.s.play({ type: 'response.done', event_id: 'r2', response: { id: 'resp_auto' } });
    expect(c.creates()).toHaveLength(2);
    expect(c.gates()).toEqual(['gate.sent.reply', 'gate.requeued', 'gate.sent.reply']);
  });

  it('an unrelated error while a response really is running changes nothing', () => {
    const c = call();
    c.answer('fc_1', 'Tuesday at 9 is free.');
    c.s.play({ type: 'response.created', event_id: 'r1', response: { id: 'resp_1' } });
    c.answer('fc_2', 'Biscuit is found.');
    c.s.play({ type: 'error', event_id: 'e1', error: { type: 'invalid_request_error', code: 'invalid_value' } });
    expect(c.creates()).toHaveLength(1);
    c.s.play({ type: 'response.done', event_id: 'r2', response: { id: 'resp_1' } });
    expect(c.creates()).toHaveLength(2);
    expect(c.gates()).toEqual(['gate.sent.reply', 'gate.queued.reply', 'gate.kept_on_error', 'gate.sent.reply']);
  });

  it('our own cancel answered "nothing to cancel" is not a failed create', () => {
    const sent: Record<string, unknown>[] = [];
    const gate = new TurnGate((e) => sent.push(e));
    gate.request(REPLY, 'reply');
    gate.error('response_cancel_not_active');
    gate.request(SAY, 'say');
    expect(sent).toEqual([REPLY]);
    expect(gate.active).toBe(true);
  });
});

describe('the turn gate: requests while a response is running', () => {
  it('two requests while active: one reply goes, and the one that may call tools wins over tool_choice none', () => {
    const sent: Record<string, unknown>[] = [];
    const log: string[] = [];
    const gate = new TurnGate((e) => sent.push(e), (e) => log.push(e.type));
    gate.request(REPLY, 'reply');
    // a tool's words to say with no tools, then a reply that may call tools: tools wins, in the first one's place
    gate.request(SAY, 'say');
    gate.request(REPLY, 'reply');
    expect(gate.queue.map((w) => w.event)).toEqual([REPLY]);
    // and a no-tools line or a hold line after it never replaces it (last-writer-wins did)
    gate.request(SAY, 'say');
    gate.request(HOLD, 'hold');
    expect(gate.queue.map((w) => w.event)).toEqual([REPLY]);
    gate.done();
    expect(sent).toEqual([REPLY, REPLY]);
    expect(log).toEqual(['gate.sent.reply', 'gate.queued.say', 'gate.merged.reply', 'gate.merged.say', 'gate.merged.hold', 'gate.sent.reply']);
    gate.done();
    expect(sent).toHaveLength(2); // nothing else was waiting
  });

  it('on the engine: a hold line queued behind a running reply gives way to the answer it was holding for', () => {
    const c = call();
    c.answer('fc_1', 'Tuesday at 9 is free.');
    c.s.play({ type: 'response.created', event_id: 'r1', response: { id: 'resp_1' } });
    // a hold line, then the answer it was holding for: one reply, the answer
    c.sideband.send({ type: 'session.thinking.append', event_id: 't1', delegation_id: 'fc_2', content: 'Still working on it. Tell the caller in a few words that you are still checking.' });
    c.answer('fc_2', 'Biscuit is found.');
    c.s.play({ type: 'response.done', event_id: 'r2', response: { id: 'resp_1' } });
    expect(c.creates()).toEqual([REPLY, REPLY]);
    expect(c.gates()).toEqual(['gate.sent.reply', 'gate.queued.hold', 'gate.merged.reply', 'gate.sent.reply']);
  });

  it('response.done drains the queue in order, one request per response', () => {
    const sent: Record<string, unknown>[] = [];
    const gate = new TurnGate((e) => sent.push(e));
    gate.started(); // a reply the server started itself is running
    gate.request(GREETING, 'greeting');
    gate.request(HOLD, 'hold');
    gate.request(REPLY, 'reply');
    expect(sent).toEqual([]);
    expect(gate.queue.map((w) => w.kind)).toEqual(['greeting', 'reply']);
    gate.done();
    expect(sent).toEqual([GREETING]);
    gate.done();
    expect(sent).toEqual([GREETING, REPLY]);
    gate.done();
    expect(sent).toEqual([GREETING, REPLY]);
    expect(gate.active).toBe(false);
  });
});

describe('the event log on a Realtime call', () => {
  it('has the greeting\'s request, every provider event and no words', () => {
    const s = socket();
    const e = new RealtimeEngine({ realtime: { calls: { accept: vi.fn(async () => {}) } } } as never, 'gpt-realtime-2.1', () => s.ws);
    void e.accept('rtc_log', DEMO_CLINIC, NOW);
    const sideband = e.attach('rtc_log');
    const log: CallEventInput[] = [];
    sideband.onTrace!((x) => log.push(x));
    s.play({ type: 'input_audio_buffer.speech_stopped', event_id: 'a', item_id: 'item_1' });
    s.play({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'b', item_id: 'item_1', transcript: 'My number is 303 555 0147, Maria Delgado' });
    s.play({ type: 'response.output_audio_transcript.delta', event_id: 'c', response_id: 'resp_1', item_id: 'item_2', delta: 'Thanks Maria' });
    expect(log.map((x) => x.type)).toEqual(['gate.sent.greeting', 'input_audio_buffer.speech_stopped', 'conversation.item.input_audio_transcription.completed', 'response.output_audio_transcript.delta']);
    expect(log[3]).toMatchObject({ responseId: 'resp_1', itemId: 'item_2' });
    expect(JSON.stringify(log)).not.toMatch(/Maria|0147/);
  });
});

// Call quality Q3 (2026-11-18): a reply the caller's words asked for went out while the model's tool call had no result
// yet, and the model said "I'm still waiting for that to complete, and I can't cancel it again until it finishes".
describe('replies wait for the tools\' results', () => {
  it('holds a reply asked for while tools are out, and sends one reply once every result is in', () => {
    const sent: Record<string, unknown>[] = [];
    const gate = new TurnGate((e) => sent.push(e));
    gate.request(REPLY, 'reply');
    gate.started();
    gate.waitForTools();
    // the caller says more before the response ends: queued
    gate.request(REPLY, 'reply');
    gate.done();
    // the response ended with its tool call: nothing goes until the result is in
    expect(sent).toHaveLength(1);
    // the result's line to say merges with the waiting reply: one reply, the one that may call tools
    gate.request(SAY, 'say');
    expect(sent).toHaveLength(1);
    gate.toolsDone();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(REPLY);
  });

  it('with nothing waiting, the result\'s own line goes as soon as the results are in', () => {
    const sent: Record<string, unknown>[] = [];
    const gate = new TurnGate((e) => sent.push(e));
    gate.waitForTools();
    gate.request(SAY, 'say');
    expect(sent).toHaveLength(0);
    gate.toolsDone();
    expect(sent).toEqual([SAY]);
  });

  it('still lets a hold line go while the tools are out', () => {
    const sent: Record<string, unknown>[] = [];
    const gate = new TurnGate((e) => sent.push(e));
    gate.waitForTools();
    gate.request(HOLD, 'hold');
    expect(sent).toEqual([HOLD]);
  });
});
