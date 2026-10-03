import { CallAgent, CallState, type Planner, ScriptedPlanner } from '@attendra/agent';
import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { createLogger } from '@attendra/observability';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CallRunner, conversationPrompt, type Sideband, type SidebandEvent, type VoiceEngine } from '../src';

const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);

function harness(planner: Planner) {
  const sent: unknown[] = [];
  const engine = { name: 'fake', accept: vi.fn(), startBrowserCall: vi.fn(), reject: vi.fn(), attach: vi.fn(), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}) } satisfies VoiceEngine;
  const sideband: Sideband = { send: (e) => sent.push(e), onEvent: () => {}, onError: () => {}, onClose: () => {}, close: vi.fn() };
  const segments: { speaker: string; text: string }[] = [];
  const closes: unknown[] = [];
  const backend = {
    patients: { findByNameAndDob: vi.fn() }, scheduler: { busy: vi.fn(), book: vi.fn(), cancel: vi.fn(), upcoming: vi.fn() },
    tasks: { create: vi.fn() }, audit: { record: vi.fn(async () => {}) }, messenger: { sendTemplate: vi.fn() },
  };
  const agent = new CallAgent(new CallState(), { clinic: DEMO_CLINIC, callId: 'call_1', callerNumber: null, now: () => NOW }, backend as never, planner, log);
  const runner = new CallRunner('live_1', engine, sideband, agent, {
    appendSegment: async (s) => { segments.push({ speaker: s.speaker, text: s.text }); },
    close: async (c) => { closes.push(c); },
  }, log);
  return { runner, sent, engine, segments, closes, sideband };
}

const delta = (type: 'in' | 'out', id: string, text: string, at: number): SidebandEvent => ({
  type: type === 'in' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', event_id: id, delta: text, start_ms: at, end_ms: at + 400,
});

describe('the GPT-Live call runner', () => {
  it('answers a delegation with thinking then commentary on the same delegation id', async () => {
    const h = harness(new ScriptedPlanner([{ tool: 'get_clinic_info', args: { question: 'do you take my insurance' } }], (r) => String(r[0]!.data.answer)));
    await h.runner.handle(delta('in', 'e1', 'Do you take Aetna?', 100));
    await h.runner.handle({ type: 'session.delegation.created', event_id: 'e2', delegation: { id: 'item_9', target: 'client' } });
    expect(h.sent).toEqual([
      { type: 'session.thinking.append', event_id: expect.any(String), delegation_id: 'item_9', content: 'Working on it.' },
      { type: 'session.commentary.append', event_id: expect.any(String), delegation_id: 'item_9', content: expect.stringContaining('Aetna') },
    ]);
  });

  it('ignores a replayed event instead of running the delegation twice', async () => {
    const plan = vi.fn(async () => ({ say: 'ok' }));
    const h = harness({ plan });
    const created: SidebandEvent = { type: 'session.delegation.created', event_id: 'e7', delegation: { id: 'item_1', target: 'client' } };
    await h.runner.handle(created);
    await h.runner.handle(created);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('sends the emergency instruction with a null delegation id and transfers after the script', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle(delta('in', 'e1', 'my wife is not breathing', 100));
    expect(h.sent[0]).toMatchObject({ type: 'session.instructions.append', delegation_id: null });
    expect(h.engine.transfer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8000);
    expect(h.engine.transfer).toHaveBeenCalledWith('live_1', 'tel:+13035550199');
    vi.useRealTimers();
  });

  it('offers a callback when a transfer fails, and says the emergency number again during an emergency', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    h.engine.transfer.mockRejectedValueOnce(new Error('sip 503'));
    await h.runner.handle(delta('in', 'e1', 'my wife is not breathing', 100));
    await vi.advanceTimersByTimeAsync(8000);
    const said = h.sent.map((e) => (e as { content: string }).content);
    expect(said).toHaveLength(3);
    expect(said[1]).toContain('transfer did not go through');
    expect(said[1]).toContain('create_callback');
    expect(said[2]).toBe(said[0]); // the emergency script, again
    vi.useRealTimers();
  });

  it('hangs up only once the assistant has finished its goodbye', async () => {
    vi.useFakeTimers();
    const h = harness(new ScriptedPlanner([]));
    await h.runner.act([{ type: 'hangup', afterMs: 3500 }]);
    // the goodbye is still being spoken when the 3.5 seconds are up
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await h.runner.handle(delta('out', `o${i}`, 'goodbye ', 1000 * i));
    }
    expect(h.engine.hangup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.engine.hangup).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('records a call staff ended as ended_by_staff, not as the assistant hanging up', async () => {
    const h = harness(new ScriptedPlanner([]));
    await h.runner.act((h.runner as unknown as { agent: CallAgent }).agent.endByStaff());
    await h.runner.handle({ type: 'session.closed', event_id: 'e9', reason: 'agent_hangup', usage: { seconds: 30 } } as SidebandEvent);
    expect(h.closes.at(-1)).toMatchObject({ reason: 'ended_by_staff' });
  });

  it('keeps agent_hangup for a call the assistant ended itself', async () => {
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle({ type: 'session.closed', event_id: 'e9', reason: 'agent_hangup', usage: { seconds: 30 } } as SidebandEvent);
    expect(h.closes.at(-1)).toMatchObject({ reason: 'agent_hangup' });
  });

  it('stores whole turns and closes the call with final usage and outcome', async () => {
    const h = harness(new ScriptedPlanner([]));
    await h.runner.handle(delta('out', 'o1', 'Thanks for calling Maple Street.', 0));
    await h.runner.handle(delta('in', 'i1', 'What are', 1000));
    await h.runner.handle(delta('in', 'i2', 'your hours?', 1500));
    await h.runner.handle({ type: 'session.closed', event_id: 'c1', reason: 'remote_hangup', usage: { seconds: 42.5 } });
    expect(h.segments).toEqual([
      { speaker: 'agent', text: 'Thanks for calling Maple Street.' },
      { speaker: 'caller', text: 'What are your hours?' },
    ]);
    expect(h.closes).toEqual([{ reason: 'remote_hangup', voiceSeconds: 42.5, outcome: 'abandoned', emergency: false }]);
    expect(h.sideband.close).toHaveBeenCalled();
  });
});

it('counts the call as over when the socket drops and the final write fails', async () => {
  const engine = { name: 'fake', accept: vi.fn(), startBrowserCall: vi.fn(), reject: vi.fn(), attach: vi.fn(), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}) } satisfies VoiceEngine;
  let drop: (code: number) => void = () => {};
  const sideband: Sideband = { send: vi.fn(), onEvent: () => {}, onError: () => {}, onClose: (h) => { drop = h; }, close: vi.fn() };
  const agent = new CallAgent(new CallState(), { clinic: DEMO_CLINIC, callId: 'call_1', callerNumber: null, now: () => NOW }, {} as never, new ScriptedPlanner([]), log);
  const runner = new CallRunner('live_1', engine, sideband, agent, { appendSegment: async () => {}, close: async () => { throw new Error('db down'); } }, log);
  const done = runner.start();
  drop(1006);
  await expect(done).resolves.toBeUndefined();
});

describe('the conversation prompt', () => {
  it('carries the greeting, the AI disclosure and today\'s hours, and nothing about any patient', () => {
    const prompt = conversationPrompt(DEMO_CLINIC, NOW);
    expect(prompt).toContain("I'm Maya, the clinic's AI assistant");
    expect(prompt).toContain('The clinic is closed right now.');
    expect(prompt).toMatch(/never give medical advice/i);
  });

  it('names the assistant, says it is an AI, and lists only the clinic\'s languages', () => {
    const prompt = conversationPrompt(DEMO_CLINIC, NOW);
    expect(prompt).toContain("You are Maya, the clinic's AI assistant.");
    expect(prompt).toContain('Never claim to be a person.');
    expect(prompt).toContain('Speak English. You may also speak Spanish if the caller does');
    expect(prompt).toContain('usted');
    expect(prompt).not.toMatch(/attendra/i);
  });

  it('falls back to a plain name when none is set, and speaks only English at an English-only clinic', () => {
    const prompt = conversationPrompt({ ...DEMO_CLINIC, assistantName: undefined, languages: ['en'], primaryLanguage: 'en' }, NOW);
    expect(prompt).toContain("You are the clinic's AI assistant.");
    expect(prompt).not.toMatch(/Spanish|attendra/i);
  });
});
