import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { describe, expect, it, vi } from 'vitest';
import { ASK_BACKEND, RealtimeEngine, type RealtimeSocket, type SidebandEvent } from '../src';

const NOW = zonedInstant('2026-09-28', '10:00', DEMO_CLINIC.timezone);

/** A Realtime call socket that records what it is sent and plays back events. */
function socket(readyState = 1) {
  const sent: Record<string, unknown>[] = [];
  const handlers: Record<string, ((x: never) => void)[]> = {};
  let onClose: ((code: number) => void) | null = null;
  let onOpen: (() => void) | null = null;
  const inner = { readyState, on: (e: 'close' | 'open', h: (code: number) => void) => { if (e === 'close') onClose = h; else onOpen = h as () => void; } };
  const ws: RealtimeSocket = {
    send: (e) => { if (inner.readyState !== 1) throw new Error('WebSocket is not open'); sent.push(e); },
    on: ((event: string, h: (x: never) => void) => { (handlers[event] ??= []).push(h); }) as RealtimeSocket['on'],
    close: vi.fn(),
    socket: inner as RealtimeSocket['socket'],
  };
  return {
    ws, sent, play: (e: Record<string, unknown>) => handlers.event?.forEach((h) => h(e as never)), closeWith: (code: number) => onClose?.(code),
    open: () => { inner.readyState = 1; onOpen?.(); },
  };
}

function engine(readyState = 1) {
  const calls = { accept: vi.fn(async () => {}), hangup: vi.fn(async () => {}), refer: vi.fn(async () => {}), reject: vi.fn(async () => {}),
    create: vi.fn(async () => new Response('v=0 answer', { headers: { location: '/v1/realtime/calls/rtc_web_1' } })) };
  const s = socket(readyState);
  const e = new RealtimeEngine({ realtime: { calls } } as never, 'gpt-realtime-2.1', () => s.ws);
  return { e, calls, s };
}

describe('the Realtime engine', () => {
  it('answers with the clinic\'s prompt, its voice, transcripts on, and one tool: the backend', async () => {
    const { e, calls } = engine();
    await e.accept('rtc_1', { ...DEMO_CLINIC, voice: 'cedar' }, NOW);
    const session = (calls.accept.mock.calls[0] as unknown[])[1] as Record<string, unknown> & { audio: { output: { voice: string } }; tools: unknown[]; instructions: string };
    expect(session).toMatchObject({ type: 'realtime', model: 'gpt-realtime-2.1', tool_choice: 'auto' });
    expect(session.audio.output.voice).toBe('cedar');
    expect(session.tools).toEqual([ASK_BACKEND]);
    expect(session.instructions).toContain(DEMO_CLINIC.greeting);
    expect(session.instructions).toContain('call ask_backend');
    expect(session.instructions).toContain('never mention a backend or a system, never say you are asking or checking with anyone');
    // a voice only GPT-Live has falls back to one both have
    await e.accept('rtc_2', { ...DEMO_CLINIC, voice: 'not-a-realtime-voice' }, NOW);
    expect(((calls.accept.mock.calls[1] as unknown[])[1] as { audio: { output: { voice: string } } }).audio.output.voice).toBe('marin');
  });

  it('turns transcripts and the hand-off into the events the call runner reads, and a clean close into the end of the call', () => {
    const { e, s } = engine();
    const sideband = e.attach('rtc_1');
    const seen: SidebandEvent[] = [];
    sideband.onEvent((ev) => seen.push(ev));
    const closed = vi.fn();
    sideband.onClose(closed);
    s.play({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'a', item_id: 'item_1', transcript: 'I need a visit' });
    s.play({ type: 'response.output_audio_transcript.delta', event_id: 'b', delta: 'Sure, one moment.' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'c', name: 'ask_backend', call_id: 'fc_1', arguments: '{"request":"book"}' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'd', name: 'something_else', call_id: 'fc_2' });
    s.closeWith(1000);
    expect(seen.map((x) => x.type)).toEqual(['session.input_transcript.delta', 'session.output_transcript.delta', 'session.delegation.created', 'session.closed']);
    expect(seen[2]).toMatchObject({ delegation: { id: 'fc_1', target: 'client' } });
    expect(closed).toHaveBeenCalledWith(1000);
  });

  it('holds the reply and its hand-off until the caller\'s words before it are transcribed, or 3 seconds at most', () => {
    vi.useFakeTimers();
    const { e, s } = engine();
    const sideband = e.attach('rtc_1');
    const seen: SidebandEvent[] = [];
    sideband.onEvent((ev) => seen.push(ev));
    s.play({ type: 'input_audio_buffer.committed', event_id: 'a', item_id: 'item_1' });
    s.play({ type: 'response.output_audio_transcript.delta', event_id: 'b', delta: 'Got it, ' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'c', name: 'ask_backend', call_id: 'fc_1' });
    expect(seen).toEqual([]);
    s.play({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'd', item_id: 'item_1', transcript: 'Her birthday is the fifth of January.' });
    expect(seen.map((x) => x.type)).toEqual(['session.input_transcript.delta', 'session.output_transcript.delta', 'session.delegation.created']);
    expect(seen[0]).toMatchObject({ delta: 'Her birthday is the fifth of January.' });

    // a transcription that never comes holds nothing for long
    s.play({ type: 'input_audio_buffer.committed', event_id: 'e', item_id: 'item_2' });
    s.play({ type: 'response.output_audio_transcript.delta', event_id: 'f', delta: 'Sorry?' });
    s.play({ type: 'response.output_audio_transcript.done', event_id: 'f2' });
    expect(seen).toHaveLength(3);
    vi.advanceTimersByTime(3000);
    expect(seen.at(-1)).toMatchObject({ type: 'session.output_transcript.delta', delta: 'Sorry?' });
    vi.useRealTimers();
  });

  it('a dropped socket is not the end of the call: the runner sees the drop itself', () => {
    const { e, s } = engine();
    const sideband = e.attach('rtc_1');
    const seen: SidebandEvent[] = [];
    sideband.onEvent((ev) => seen.push(ev));
    sideband.onClose(() => {});
    s.closeWith(1006);
    expect(seen).toEqual([]);
  });

  it('greets first, answers a hand-off with the tool\'s result, and acts on new instructions at once, one response at a time', () => {
    const { e, s } = engine();
    void e.accept('rtc_1', DEMO_CLINIC, NOW);
    const sideband = e.attach('rtc_1');
    // the assistant speaks first: the greeting
    expect(s.sent).toEqual([{ type: 'response.create' }]);
    s.play({ type: 'response.done', event_id: 'g' });
    sideband.send({ type: 'session.thinking.append', event_id: 'x1', delegation_id: 'fc_1', content: 'Working on it.' });
    expect(s.sent).toHaveLength(1); // a progress note is not said
    sideband.send({ type: 'session.thinking.append', event_id: 'x2', delegation_id: 'fc_1', content: 'Still working on it. Tell the caller in a few words that you are still checking.' });
    expect(s.sent[1]).toMatchObject({ type: 'response.create', response: { tool_choice: 'none' } });
    s.play({ type: 'response.done', event_id: 'r1' });
    sideband.send({ type: 'session.commentary.append', event_id: 'x3', delegation_id: 'fc_1', content: 'Tuesday at 9 is free.' });
    expect(s.sent.slice(2)).toEqual([
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'fc_1', output: 'Tuesday at 9 is free.' } },
      { type: 'response.create' },
    ]);
    // the answer is still being spoken: the script cuts it off, and is said once it has stopped
    sideband.send({ type: 'session.instructions.append', event_id: 'x4', delegation_id: null, content: 'Say exactly: "Please hang up and call 911."' });
    expect(s.sent.slice(4).map((x) => x.type)).toEqual(['conversation.item.create', 'response.cancel']);
    expect(JSON.stringify(s.sent[4])).toContain('Please hang up and call 911.');
    expect(s.sent.some((x) => x.type === 'session.update')).toBe(false); // a one-off note never becomes a standing rule
    s.play({ type: 'response.done', event_id: 'r2' });
    expect(s.sent.at(-1)).toEqual({ type: 'response.create' });
  });

  it('keeps what is sent before the socket opens, then greets with it as context', () => {
    const { e, s } = engine(0);
    const sideband = e.attach('rtc_1');
    sideband.send({ type: 'session.instructions.append', event_id: 'v', delegation_id: null, content: 'This caller is on the VIP list.' });
    expect(s.sent).toEqual([]);
    s.open();
    expect(s.sent.map((x) => x.type)).toEqual(['conversation.item.create', 'response.create']);
    expect(JSON.stringify(s.sent[0])).toContain('VIP list');
  });

  it('passes the assistant\'s words on a word at a time, never split inside a word', () => {
    const { e, s } = engine();
    const sideband = e.attach('rtc_1');
    const seen: string[] = [];
    sideband.onEvent((ev) => { if (ev.type === 'session.output_transcript.delta') seen.push((ev as { delta: string }).delta); });
    for (const d of ['Thanks for calling River', 'bend. I', "'m Jun", 'iper, how can I help Bisc', 'uit today?']) s.play({ type: 'response.output_audio_transcript.delta', event_id: d, delta: d });
    s.play({ type: 'response.output_audio_transcript.done', event_id: 'done' });
    expect(seen.join('')).toBe("Thanks for calling Riverbend. I'm Juniper, how can I help Biscuit today?");
    expect(seen.every((x, i) => i === seen.length - 1 || x.endsWith(' '))).toBe(true);
  });

  it('starts a test call from the browser\'s offer and ends calls through the API', async () => {
    const { e, calls } = engine();
    const started = await e.startBrowserCall(DEMO_CLINIC, 'v=0 offer', NOW);
    expect(started).toEqual({ sessionId: 'rtc_web_1', sdpAnswer: 'v=0 answer' });
    await expect(e.transfer('rtc_web_1', 'tel:+13035550199')).rejects.toThrow('cannot be transferred');
    await e.hangup('rtc_web_1');
    expect(calls.hangup).toHaveBeenCalledWith('rtc_web_1');
    await e.transfer('rtc_phone', 'tel:+13035550199');
    expect(calls.refer).toHaveBeenCalledWith('rtc_phone', { target_uri: 'tel:+13035550199' });
  });
});
