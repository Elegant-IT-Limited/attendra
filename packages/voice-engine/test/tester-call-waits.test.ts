import { CallAgent, CallState, ScriptedPlanner } from '@attendra/agent';
import { DEMO_CLINIC, RIVERBEND_CLINIC, zonedInstant } from '@attendra/core';
import { createLogger } from '@attendra/observability';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CallRunner, HOLD_LINE, RealtimeEngine, type RealtimeSocket, type Sideband, type SidebandEvent, type VoiceEngine } from '../src';

// A tester's 14-minute call on the demo clinic (2026-11-24): silences of 13, 17 and 20 s that the call page showed as
// "Longest wait 2.6 s", an opening reply that started "Sorry for the wait. One If ..." and said a sentence twice, and
// "One moment. One moment." Each cause the code can hold a reply by, with its cap.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const NOW = zonedInstant('2026-09-28', '10:00', DEMO_CLINIC.timezone);
const vet = { ...RIVERBEND_CLINIC, voiceFlow: 'tools' as const };

function harness() {
  const sent: { type: string; content?: string }[] = [];
  const engine = { name: 'fake', accept: vi.fn(), startBrowserCall: vi.fn(), reject: vi.fn(), attach: vi.fn(), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}) } satisfies VoiceEngine;
  const sideband: Sideband = { send: (e) => sent.push(e as never), onEvent: () => {}, onError: () => {}, onClose: () => {}, close: vi.fn() };
  const closes: { quality: { maxGapMs: number | null } }[] = [];
  const backend = { patients: {}, scheduler: {}, tasks: {}, audit: { record: vi.fn(async () => {}) }, messenger: {} };
  const agent = new CallAgent(new CallState(), { clinic: DEMO_CLINIC, callId: 'call_1', callerNumber: null, now: () => NOW }, backend as never, new ScriptedPlanner([]), log);
  const runner = new CallRunner('live_1', engine, sideband, agent, { appendSegment: async () => {}, close: async (c) => { closes.push(c as never); } }, log);
  return { runner, sent, closes, agent };
}
const said = (type: 'in' | 'out', id: string, text: string, at: number, ms = 400): SidebandEvent => ({
  type: type === 'in' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', event_id: id, delta: text, start_ms: at, end_ms: at + ms,
});

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
async function engineFor(id: string) {
  const s = realtimeSocket();
  const e = new RealtimeEngine({ realtime: { calls: { accept: vi.fn(async () => {}) } } } as never, 'gpt-realtime-2.1', () => s.ws);
  await e.accept(id, vet, NOW, undefined, { flow: 'tools' });
  const sideband = e.attach(id);
  s.play({ type: 'response.done', event_id: `${id}_g` }); // the greeting's reply is over
  return { s, sideband };
}
const creates = (s: ReturnType<typeof realtimeSocket>, from = 0) => s.sent.slice(from).filter((x) => x.type === 'response.create');
/** A caller turn with words: started, stopped, committed and written down. */
function turn(s: ReturnType<typeof realtimeSocket>, item: string, words: string) {
  s.play({ type: 'input_audio_buffer.speech_started', event_id: `${item}_a`, item_id: item });
  vi.advanceTimersByTime(2600);
  s.play({ type: 'input_audio_buffer.speech_stopped', event_id: `${item}_b`, item_id: item });
  s.play({ type: 'input_audio_buffer.committed', event_id: `${item}_c`, item_id: item });
  s.play({ type: 'conversation.item.input_audio_transcription.completed', event_id: `${item}_t`, item_id: item, transcript: words });
}
/** The model's reply calls a tool, and the reply ends while its result is still out. */
function toolCalled(s: ReturnType<typeof realtimeSocket>, callId: string, name = 'find_slots') {
  s.play({ type: 'response.created', event_id: `${callId}_rc` });
  s.play({ type: 'response.function_call_arguments.done', event_id: `${callId}_f`, call_id: callId, name, arguments: '{}' });
  s.play({ type: 'response.done', event_id: `${callId}_rd` });
}

describe('T4: the longest wait the call page shows', () => {
  it('T4: counts a silence the caller broke themselves ("Can you hear me?"), from the end of their words to the reply', async () => {
    const h = harness();
    await h.runner.handle(said('out', 'o1', 'Thanks for calling. How can I help?', 0, 1500));
    await h.runner.handle(said('in', 'i1', 'I want to register my cat.', 2000, 1500)); // ends at 3500
    await h.runner.handle(said('in', 'i2', 'Can you hear me?', 16_500, 800)); // 13 s of silence
    await h.runner.handle(said('out', 'o2', 'Yes, sorry. What is her name?', 18_000));
    await h.runner.handle({ type: 'session.closed', event_id: 'c1', reason: 'remote_hangup', usage: { seconds: 20 } });
    expect(h.closes.at(-1)!.quality.maxGapMs).toBe(13_000);
  });
});

describe('T4: what can hold a reply, each with a cap', () => {
  it('T4: a reply held while noise looked like the caller talking goes when that "turn" ends with no words', async () => {
    vi.useFakeTimers();
    const { s, sideband } = await engineFor('rtc_t4a');
    turn(s, 'i1', 'Is Tuesday free?');
    toolCalled(s, 'call_1');
    const start = s.sent.length;
    s.play({ type: 'input_audio_buffer.speech_started', event_id: 'n1', item_id: 'i2' }); // a dog barks
    sideband.send({ type: 'tool.result', event_id: 't1', call_id: 'call_1', output: JSON.stringify({ ok: true, outcome: 'ok', spoken: 'Tuesday at 9 is free.' }) });
    expect(creates(s, start)).toHaveLength(0);
    vi.advanceTimersByTime(600);
    s.play({ type: 'input_audio_buffer.speech_stopped', event_id: 'n2', item_id: 'i2' });
    s.play({ type: 'input_audio_buffer.committed', event_id: 'n3', item_id: 'i2' });
    s.play({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'n4', item_id: 'i2', transcript: '' });
    vi.advanceTimersByTime(2000);
    expect(creates(s, start)).toHaveLength(1);
    vi.useRealTimers();
  });

  it('T4: a start of speech with no end holds a reply (and a nudge) until the lost-stop cap (15 s), then it goes', async () => {
    vi.useFakeTimers();
    const { s, sideband } = await engineFor('rtc_t4b');
    turn(s, 'i1', 'Is Tuesday free?');
    toolCalled(s, 'call_1');
    const start = s.sent.length;
    s.play({ type: 'input_audio_buffer.speech_started', event_id: 'n1', item_id: 'i2' }); // a TV, and no stop ever comes
    sideband.send({ type: 'tool.result', event_id: 't1', call_id: 'call_1', output: JSON.stringify({ ok: true, outcome: 'ok', spoken: 'Tuesday at 9 is free.' }) });
    sideband.send({ type: 'session.commentary.append', event_id: 'nudge', delegation_id: null, content: 'The caller is waiting. Answer them now.' } as never);
    vi.advanceTimersByTime(14_000);
    expect(creates(s, start)).toHaveLength(0);
    vi.advanceTimersByTime(1100);
    expect(creates(s, start)).toHaveLength(1);
    vi.useRealTimers();
  });

  it('T4: a slow tool is never silence: one hold line after 2.5 s, a thank-you later, and nothing doubled', async () => {
    vi.useFakeTimers();
    const { s } = await engineFor('rtc_t4c');
    turn(s, 'i1', 'Can you book another pet?');
    toolCalled(s, 'call_1', 'verify_caller');
    const start = s.sent.length;
    vi.advanceTimersByTime(2400);
    expect(creates(s, start)).toHaveLength(0);
    vi.advanceTimersByTime(200);
    const holds = () => creates(s, start).map((x) => (x.response as { instructions?: string } | undefined)?.instructions);
    expect(holds()).toEqual([HOLD_LINE]);
    s.play({ type: 'response.created', event_id: 'h_rc' });
    s.play({ type: 'response.done', event_id: 'h_rd' });
    vi.advanceTimersByTime(8000);
    expect(holds()).toHaveLength(2);
    expect(holds()[1]).not.toBe(HOLD_LINE);
    vi.useRealTimers();
  });
});

describe('T9: nothing said twice', () => {
  it('T9: a reply whose audio has started is never talked over by a silence nudge (it was cut at "One" and said again)', async () => {
    vi.useFakeTimers();
    const h = harness();
    void h.runner.start();
    await h.runner.handle({ type: 'session.output_audio.delta', event_id: 'a0', delta: '' }); // the greeting
    await h.runner.handle(said('out', 'o1', 'Thanks for calling.', 0));
    await vi.advanceTimersByTimeAsync(3000);
    await h.runner.handle(said('in', 'i1', 'My cat seems very sick.', 3000));
    await vi.advanceTimersByTimeAsync(1500);
    // the reply's audio starts; its words are held until the caller's transcript is in, and come later
    await h.runner.handle({ type: 'session.output_audio.delta', event_id: 'a1', delta: '' });
    await vi.advanceTimersByTimeAsync(13_000);
    expect(h.sent.filter((e) => e.type === 'session.commentary.append' || /waiting/.test(e.content ?? ''))).toEqual([]);
    vi.useRealTimers();
  });

  it('T9: after the short acknowledgement, the reply is told not to say another ("One moment. One moment.")', async () => {
    vi.useFakeTimers();
    const { s, sideband } = await engineFor('rtc_t9b');
    sideband.send({ type: 'turns.manual', event_id: 'm', on: true });
    turn(s, 'i0', 'Hi, I have a question about my cat.'); // the first words are in: later turns get the acknowledgement
    sideband.send({ type: 'reply.go', event_id: 'g0' });
    s.play({ type: 'response.created', event_id: 'r0c' });
    s.play({ type: 'response.done', event_id: 'r0d' });
    const start = s.sent.length;
    turn(s, 'i1', 'Can you book her for Tuesday morning?');
    vi.advanceTimersByTime(700); // the acknowledgement goes
    s.play({ type: 'response.created', event_id: 'ack_c' });
    s.play({ type: 'response.done', event_id: 'ack_d' });
    sideband.send({ type: 'reply.go', event_id: 'g1' });
    const after = s.sent.slice(start);
    const notes = after.filter((x) => x.type === 'conversation.item.create').map((x) => JSON.stringify(x));
    expect(notes.some((n) => /already said a short acknowledgement/i.test(n))).toBe(true);
    expect(creates(s, start)).toHaveLength(2);
    vi.useRealTimers();
  });
});

describe('T4 review: a held reply never starts over a caller still talking; the wait counts only what the assistant owed', () => {
  it('T4-review2: a caller talking 12 s (speech started, no stop for 12 s) holds the reply the whole time; their turn\'s end answers once', async () => {
    vi.useFakeTimers();
    const { s, sideband } = await engineFor('rtc_t4r1');
    turn(s, 'i1', 'Is Tuesday free?');
    toolCalled(s, 'call_1');
    const start = s.sent.length;
    // the real event order: speech started ... (no transcript while they talk) ... stopped, committed, then the transcript
    s.play({ type: 'input_audio_buffer.speech_started', event_id: 'n1', item_id: 'i2' });
    sideband.send({ type: 'tool.result', event_id: 't1', call_id: 'call_1', output: JSON.stringify({ ok: true, outcome: 'ok', spoken: 'Tuesday at 9 is free.' }) });
    for (let sec = 1; sec <= 12; sec++) {
      vi.advanceTimersByTime(1000);
      expect(creates(s, start), `${sec} s`).toHaveLength(0);
    }
    s.play({ type: 'input_audio_buffer.speech_stopped', event_id: 'n2', item_id: 'i2' });
    s.play({ type: 'input_audio_buffer.committed', event_id: 'n3', item_id: 'i2' });
    s.play({ type: 'conversation.item.input_audio_transcription.completed', event_id: 'n4', item_id: 'i2', transcript: 'and actually, could it be Wednesday instead, in the afternoon, with Dr. Bell if she is in that day?' });
    vi.advanceTimersByTime(2000);
    expect(creates(s, start)).toHaveLength(1);
    vi.useRealTimers();
  });

  it('T4-review2: a lost stop event (15 s, no stop, no new start): the stale line is dropped and the caller\'s latest words are answered', async () => {
    vi.useFakeTimers();
    const { s, sideband } = await engineFor('rtc_t4r2');
    turn(s, 'i1', 'Is Tuesday free?');
    toolCalled(s, 'call_1');
    const start = s.sent.length;
    s.play({ type: 'input_audio_buffer.speech_started', event_id: 'n1', item_id: 'i2' });
    sideband.send({ type: 'tool.result', event_id: 't1', call_id: 'call_1', output: JSON.stringify({ ok: false, outcome: 'refused', say: 'Say, in these words: "Tuesday is fully booked."' }) });
    vi.advanceTimersByTime(14_500);
    expect(creates(s, start)).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    const sent = creates(s, start);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.response as { tool_choice?: string } | undefined)?.tool_choice).toBeUndefined();
    vi.useRealTimers();
  });

  it('T4-review: the caller\'s own pauses between sentences are no wait; a silence the assistant owed is', async () => {
    const h = harness();
    await h.runner.handle(said('out', 'o1', 'Thanks for calling. How can I help?', 0, 1500));
    await h.runner.handle(said('in', 'i1', 'I want to register my cat.', 2000, 1500)); // ends 3500
    await h.runner.handle(said('in', 'i2', 'She is two years old.', 5500, 1000)); // a 2 s pause of the caller's own
    await h.runner.handle(said('out', 'o2', 'What is her name?', 7300)); // 800 ms after
    await h.runner.handle({ type: 'session.closed', event_id: 'c1', reason: 'remote_hangup', usage: { seconds: 10 } });
    expect(h.closes.at(-1)!.quality.maxGapMs).toBe(800);
  });
});

describe('T4-vad: a caller turn the VAD kept open long after the words is a wait', () => {
  it('T4-vad: 3 words over 11.1 s (speech_started 102995 → speech_stopped 114085) counts as a wait of 9 s or more; the reply within 1 ms adds none', async () => {
    const h = harness();
    await h.runner.handle(said('out', 'o1', 'Thanks for calling. How can I help?', 0, 1500));
    await h.runner.handle(said('in', 'i1', 'Are you there?', 102_995, 114_085 - 102_995));
    await h.runner.handle(said('out', 'o2', 'Yes, I can hear you.', 114_086));
    await h.runner.handle({ type: 'session.closed', event_id: 'c1', reason: 'remote_hangup', usage: { seconds: 120 } });
    expect(h.closes.at(-1)!.quality.maxGapMs).toBeGreaterThanOrEqual(9000);
  });

  it('T4-vad: a normal 3-word turn of 1.5 s answered at once adds no wait', async () => {
    const h = harness();
    await h.runner.handle(said('out', 'o1', 'Thanks for calling. How can I help?', 0, 1500));
    await h.runner.handle(said('in', 'i1', 'Are you there?', 2000, 1500));
    await h.runner.handle(said('out', 'o2', 'Yes, I can hear you.', 3700));
    await h.runner.handle({ type: 'session.closed', event_id: 'c1', reason: 'remote_hangup', usage: { seconds: 5 } });
    expect(h.closes.at(-1)!.quality.maxGapMs).toBe(200);
  });
});
