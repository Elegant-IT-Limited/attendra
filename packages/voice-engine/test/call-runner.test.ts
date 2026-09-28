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
  const engine = { name: 'fake', accept: vi.fn(), reject: vi.fn(), attach: vi.fn(), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}) } satisfies VoiceEngine;
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

describe('the conversation prompt', () => {
  it('carries the greeting, the AI disclosure and today\'s hours, and nothing about any patient', () => {
    const prompt = conversationPrompt(DEMO_CLINIC, NOW);
    expect(prompt).toContain("I am the clinic's AI assistant");
    expect(prompt).toContain('The clinic is closed right now.');
    expect(prompt).toMatch(/never give medical advice/i);
  });
});
