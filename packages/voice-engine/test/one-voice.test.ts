import { CallAgent, CallState, ScriptedPlanner } from '@attendra/agent';
import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { createLogger } from '@attendra/observability';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { CallRunner, EngineRouter, GptLiveEngine, RealtimeEngine, type SidebandConnection, type SidebandEvent, type SidebandSocket } from '../src';

const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);
const CLINIC = { ...DEMO_CLINIC, voice: 'cedar' };

/** One sideband the test drives: events in, everything sent kept, and the SDK's connection events on demand. */
function fakeSideband() {
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  const opens: (() => void)[] = [];
  const sent: Record<string, unknown>[] = [];
  const emit = (name: string, arg?: unknown) => (handlers.get(name) ?? []).forEach((h) => h(arg));
  const socket = {
    socket: { readyState: 1, on: (_e: 'open', h: () => void) => opens.push(h) },
    send: (e: Record<string, unknown>) => { sent.push(e); },
    on: ((name: string, h: (e: unknown) => void) => { handlers.set(name, [...(handlers.get(name) ?? []), h]); }) as never,
    close: () => emit('close', 1000),
  } as unknown as SidebandSocket;
  return { socket, sent, emit, opened: () => opens.forEach((h) => h()) };
}

function fakeClient() {
  const create = vi.fn(async () => ({ session: { id: 'live_web' }, transport: { type: 'webrtc', sdp: 'v=0 answer' } }));
  const sessions = { accept: vi.fn(async () => {}), refer: vi.fn(async () => {}), hangup: vi.fn(async () => {}), reject: vi.fn(async () => {}) };
  return { client: { live: { create, sessions } } as unknown as OpenAI, create };
}

const delta = (type: 'in' | 'out', id: string, text: string): SidebandEvent => ({
  type: type === 'in' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', event_id: id, delta: text, start_ms: 0, end_ms: 400,
});

describe('one voice for the whole call (2026-10-26: a caller heard it change)', () => {
  it('is set once, when the session is created, and nothing the call sends afterwards can change it', async () => {
    vi.useFakeTimers();
    const { client, create } = fakeClient();
    const sideband = fakeSideband();
    const engine = new GptLiveEngine(client, 'gpt-live-1', () => sideband.socket);
    const router = new EngineRouter({ 'gpt-live': engine }, 'gpt-live');
    const { sessionId } = await router.startBrowserCall(CLINIC, 'v=0 offer', NOW);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown as [{ session: { audio: unknown } }])[0].session.audio).toEqual({ output: { voice: 'cedar' } });
    expect(router.sessionInfo(sessionId)).toEqual({ engine: 'gpt-live', voice: 'cedar' });

    // a whole call's worth of what the backend sends: the greeting nudge, a hand-off and its answer, silence nudges, a staff note, a goodbye
    const agent = new CallAgent(new CallState(), { clinic: CLINIC, callId: 'call_1', callerNumber: null, now: () => NOW }, {} as never, new ScriptedPlanner([], () => 'We open at eight.'), log);
    const runner = new CallRunner(sessionId, router, router.attach(sessionId), agent, { appendSegment: async () => {}, close: async () => {} }, log);
    void runner.start();
    await vi.advanceTimersByTimeAsync(2500);
    sideband.emit('event', delta('out', 'o1', 'Thanks for calling.'));
    sideband.emit('event', delta('in', 'i1', 'When do you open tomorrow?'));
    await vi.advanceTimersByTimeAsync(20_000);
    sideband.emit('event', { type: 'session.delegation.created', event_id: 'd1', delegation: { id: 'item_1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(100);
    await runner.act(agent.coach('Mention the parking.'));
    await runner.act(agent.endByStaff());
    await vi.advanceTimersByTimeAsync(10_000);

    const types = new Set(sideband.sent.map((e) => e.type));
    expect([...types].sort()).toEqual(['session.close', 'session.commentary.append', 'session.instructions.append', 'session.thinking.append']);
    // no session.update, no second session, and no voice or audio setting in anything sent
    for (const e of sideband.sent) expect(Object.keys(e).filter((k) => /voice|audio|session$/.test(k))).toEqual([]);
    expect(JSON.stringify(sideband.sent)).not.toContain('"voice"');
    expect(create).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('a Realtime call keeps the voice it was created with, too', async () => {
    const calls = { create: vi.fn(async () => ({ headers: new Headers({ location: '/v1/realtime/calls/rtc_1' }), text: async () => 'v=0 answer' })) };
    const engine = new RealtimeEngine({ realtime: { calls } } as unknown as OpenAI);
    await engine.startBrowserCall({ ...CLINIC, voice: 'marin' }, 'v=0 offer', NOW);
    expect(engine.sessionInfo('rtc_1')).toEqual({ engine: 'gpt-realtime', voice: 'marin' });
  });

  it('no code that talks to a session ever sends session.update', () => {
    const dirs = ['packages/voice-engine/src', 'packages/agent/src', 'apps/voice/src'].map((d) => join(import.meta.dirname, '../../..', d));
    for (const dir of dirs) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/['"`]session\.update['"`]/);
      }
    }
  });
});

describe('the sideband comes back after a drop, and says so', () => {
  it('reports its connection, and closes the call only when the SDK gives up', () => {
    const { client } = fakeClient();
    const sideband = fakeSideband();
    const engine = new GptLiveEngine(client, 'gpt-live-1', () => sideband.socket);
    const sb = engine.attach('live_1');
    const seen: SidebandConnection[] = [];
    const closed: number[] = [];
    sb.onConnection!((c) => seen.push(c));
    sb.onClose((c) => closed.push(c));
    sideband.opened();
    sideband.emit('reconnecting', { attempt: 1, closeCode: 1006 });
    sideband.emit('reconnected');
    expect(seen).toEqual([{ state: 'open' }, { state: 'reconnecting', attempt: 1, code: 1006 }, { state: 'reconnected' }]);
    expect(closed).toEqual([]);
    sideband.emit('close', 1006);
    expect(closed).toEqual([1006]);
  });
});
