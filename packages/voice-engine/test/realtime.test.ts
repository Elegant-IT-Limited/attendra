import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { describe, expect, it, vi } from 'vitest';
import { ASK_BACKEND, RealtimeEngine, type RealtimeSocket, type SidebandEvent } from '../src';

const NOW = zonedInstant('2026-09-28', '10:00', DEMO_CLINIC.timezone);

/** A Realtime call socket that records what it is sent and plays back events. */
function socket() {
  const sent: Record<string, unknown>[] = [];
  const handlers: Record<string, ((x: never) => void)[]> = {};
  let onClose: ((code: number) => void) | null = null;
  const ws: RealtimeSocket = {
    send: (e) => { sent.push(e); },
    on: ((event: string, h: (x: never) => void) => { (handlers[event] ??= []).push(h); }) as RealtimeSocket['on'],
    close: vi.fn(),
    socket: { on: (_e: 'close', h: (code: number) => void) => { onClose = h; } },
  };
  return { ws, sent, play: (e: Record<string, unknown>) => handlers.event?.forEach((h) => h(e as never)), closeWith: (code: number) => onClose?.(code) };
}

function engine() {
  const calls = { accept: vi.fn(async () => {}), hangup: vi.fn(async () => {}), refer: vi.fn(async () => {}), reject: vi.fn(async () => {}),
    create: vi.fn(async () => new Response('v=0 answer', { headers: { location: '/v1/realtime/calls/rtc_web_1' } })) };
  const s = socket();
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
    s.play({ type: 'conversation.item.input_audio_transcription.delta', event_id: 'a', delta: 'I need a visit' });
    s.play({ type: 'response.output_audio_transcript.delta', event_id: 'b', delta: 'Sure, one moment.' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'c', name: 'ask_backend', call_id: 'fc_1', arguments: '{"request":"book"}' });
    s.play({ type: 'response.function_call_arguments.done', event_id: 'd', name: 'something_else', call_id: 'fc_2' });
    s.closeWith(1000);
    expect(seen.map((x) => x.type)).toEqual(['session.input_transcript.delta', 'session.output_transcript.delta', 'session.delegation.created', 'session.closed']);
    expect(seen[2]).toMatchObject({ delegation: { id: 'fc_1', target: 'client' } });
    expect(closed).toHaveBeenCalledWith(1000);
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

  it('answers a hand-off with the tool\'s result, and acts on new instructions at once', () => {
    const { e, s } = engine();
    void e.accept('rtc_1', DEMO_CLINIC, NOW);
    const sideband = e.attach('rtc_1');
    sideband.send({ type: 'session.thinking.append', event_id: 'x1', delegation_id: 'fc_1', content: 'Working on it.' });
    expect(s.sent).toEqual([]); // a progress note is not said
    sideband.send({ type: 'session.thinking.append', event_id: 'x2', delegation_id: 'fc_1', content: 'Still working on it. Tell the caller in a few words that you are still checking.' });
    expect(s.sent[0]).toMatchObject({ type: 'response.create', response: { tool_choice: 'none' } });
    sideband.send({ type: 'session.commentary.append', event_id: 'x3', delegation_id: 'fc_1', content: 'Tuesday at 9 is free.' });
    expect(s.sent.slice(1)).toEqual([
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'fc_1', output: 'Tuesday at 9 is free.' } },
      { type: 'response.create' },
    ]);
    sideband.send({ type: 'session.instructions.append', event_id: 'x4', delegation_id: null, content: 'Say exactly: "Please hang up and call 911."' });
    expect(s.sent.slice(3).map((x) => x.type)).toEqual(['response.cancel', 'session.update', 'conversation.item.create', 'response.create']);
    expect((s.sent[4] as { session: { instructions: string } }).session.instructions).toContain('Please hang up and call 911.');
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
