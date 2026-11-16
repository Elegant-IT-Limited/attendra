import { ScriptedPlanner } from '@attendra/agent';
import { DEMO_CLINIC } from '@attendra/core';
import { type Alerter, createLogger } from '@attendra/observability';
import type { Sideband } from '@attendra/voice-engine';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Drain, DRAIN_CUT_TEXT, drainForRestart, type DrainResult } from '../src/drain';
import { buildServer, drainOf, type IncomingCall, type VoiceDeps, WEB_CLOSE_GRACE_MS } from '../src/server';

// A restart lets the calls finish (Batch A item 4): new calls go to the backup route, live ones end on their own,
// and the deadline or a second signal cuts what is left with a goodbye. Fake engine, made-up numbers only.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const TOKEN = 'an-internal-token-for-the-drain-tests-0123456789';

/** An engine whose calls stay live until the test ends them (or the server hangs them up). */
function fakeEngine() {
  const closers = new Map<string, (code: number) => void>();
  const sent = new Map<string, unknown[]>();
  const end = (sessionId: string) => { const h = closers.get(sessionId); closers.delete(sessionId); h?.(1000); };
  const engine = {
    name: 'fake',
    accept: vi.fn(async () => {}),
    startBrowserCall: vi.fn(async () => ({ sessionId: `live_web_${closers.size + sent.size}`, sdpAnswer: 'v=0 answer' })),
    reject: vi.fn(async () => {}),
    transfer: vi.fn(async () => {}),
    hangup: vi.fn(async (sessionId: string) => { setTimeout(() => end(sessionId), 0); }),
    release: vi.fn(),
    attach: vi.fn((sessionId: string): Sideband => {
      sent.set(sessionId, []);
      return { send: (e) => { sent.get(sessionId)!.push(e); }, onEvent: () => {}, onError: () => {}, onClose: (h) => { closers.set(sessionId, h); }, close: () => end(sessionId) };
    }),
  } satisfies VoiceDeps['engine'];
  return { engine, end, sent, live: () => [...closers.keys()] };
}

function server(over: Partial<VoiceDeps> = {}) {
  const fake = fakeEngine();
  const seen = new Set<string>();
  let n = 0;
  const d: VoiceDeps = {
    verifyWebhook: async (raw) => JSON.parse(raw) as IncomingCall,
    claimDelivery: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    clinicForNumber: async (num) => (num === '+13035550100' ? DEMO_CLINIC : null),
    clinicById: async (id) => (id === DEMO_CLINIC.id ? DEMO_CLINIC : null),
    openCall: vi.fn(async () => `call_${++n}`),
    recorderFor: () => ({ appendSegment: async () => {}, close: async () => {} }),
    actionsFor: () => ({ record: async () => {} }),
    engine: fake.engine, backend: {} as never, planner: new ScriptedPlanner([]), log,
    internalToken: TOKEN,
    drainTiming: { pollMs: 10, goodbyeMs: 20 },
    ...over,
  };
  const app = buildServer(d);
  return { app, drain: drainOf(app), ...fake };
}

const ring = (app: ReturnType<typeof buildServer>, sessionId: string, delivery = `wh_${sessionId}`) => app.inject({
  method: 'POST', url: '/webhooks/openai', headers: { 'content-type': 'application/json' },
  payload: JSON.stringify({ id: delivery, type: 'live.transport.incoming', data: { session_id: sessionId, sip_headers: [{ name: 'To', value: '<sip:+13035550100@sip.api.openai.com>' }, { name: 'From', value: '<sip:+13035550147@x>' }] } }),
});
const until = async (ok: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const settled = <T>(p: Promise<T>) => { let v: T | undefined; void p.then((x) => { v = x; }); return () => v; };

describe('a restart drains the live calls', () => {
  it('with 2 live calls, waits for both and ends once the last one is over', async () => {
    const { app, drain, live, end } = server();
    await ring(app, 'live_a');
    await ring(app, 'live_b');
    await until(() => live().length === 2);
    expect(drain.liveCalls()).toBe(2);

    const result = settled(drain.start(60_000));
    expect(drain.draining).toBe(true);
    end('live_a');
    await new Promise((r) => setTimeout(r, 60));
    // one call still live: the drain still waits
    expect(result()).toBeUndefined();
    expect(drain.liveCalls()).toBe(1);
    end('live_b');
    await until(() => result() !== undefined);
    expect(result()).toMatchObject({ end: 'idle', cut: 0 });
    expect(drain.liveCalls()).toBe(0);
    await app.close();
  });

  it('ends at once when no call is live', async () => {
    const { app, drain } = server();
    expect(await drain.start(60_000)).toMatchObject({ end: 'idle', cut: 0 });
    await app.close();
  });

  it('sends a new phone call to the backup route (SIP 503, which Twilio fails over on), never answering it', async () => {
    const { app, drain, engine, live, end } = server();
    await ring(app, 'live_a');
    await until(() => live().length === 1);
    const result = settled(drain.start(60_000));

    // the same call arriving once per engine: both deliveries get the 503, so neither is left ringing; it counts once
    expect((await ring(app, 'live_u1_new')).statusCode).toBe(200);
    expect((await ring(app, 'rtc_u1_new')).statusCode).toBe(200);
    await until(() => engine.reject.mock.calls.length === 2);
    expect(engine.reject.mock.calls).toEqual([['live_u1_new', 503], ['rtc_u1_new', 503]]);
    expect(engine.accept).toHaveBeenCalledTimes(1);
    expect(drain.turnedAway()).toBe(1);

    end('live_a');
    await until(() => result() !== undefined);
    expect(result()).toMatchObject({ end: 'idle', cut: 0 });
    await app.close();
  });

  it('refuses a new browser test call with voice_restarting, and lets the open one finish', async () => {
    const { app, drain, live, end } = server();
    const start = () => app.inject({ method: 'POST', url: '/internal/web-calls', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, payload: JSON.stringify({ clinicId: DEMO_CLINIC.id, userId: 'user_1', sdp: 'v=0 offer' }) });
    expect((await start()).statusCode).toBe(201);
    await until(() => live().length === 1);
    const result = settled(drain.start(60_000));

    const refused = await start();
    expect([refused.statusCode, refused.json()]).toEqual([503, { error: 'voice_restarting' }]);
    expect(drain.turnedAway()).toBe(1);
    expect(drain.liveCalls()).toBe(1);
    // a browser call's close waits WEB_CLOSE_GRACE_MS for the page's own end before it is over
    end(live()[0]!);
    await until(() => result() !== undefined, WEB_CLOSE_GRACE_MS + 3000);
    expect(result()).toMatchObject({ end: 'idle', cut: 0 });
    await app.close();
  });

  it('at the deadline cuts what is still live, each call with a goodbye and a hang-up, and says how many', async () => {
    const { app, drain, engine, live, sent } = server();
    await ring(app, 'live_a');
    await ring(app, 'live_b');
    await until(() => live().length === 2);

    const r = await drain.start(50);
    expect(r).toMatchObject({ end: 'deadline', cut: 2 });
    // the voice was told to say goodbye, then each line was closed
    for (const id of ['live_a', 'live_b']) {
      expect(sent.get(id)).toContainEqual(expect.objectContaining({ type: 'session.instructions.append', content: DRAIN_CUT_TEXT }));
      expect(engine.hangup).toHaveBeenCalledWith(id);
    }
    expect(live()).toEqual([]);
    expect(drain.liveCalls()).toBe(0);
    await app.close();
  });

  it('a second signal cuts the live calls at once, without waiting for the deadline', async () => {
    const { app, drain, live } = server();
    await ring(app, 'live_a');
    await until(() => live().length === 1);
    const t0 = Date.now();
    const result = drain.start(60_000);
    drain.force();
    expect(await result).toMatchObject({ end: 'signal', cut: 1 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(live()).toEqual([]);
    await app.close();
  });

  it('keeps answering its health check through the drain, with the live count', async () => {
    const { app, drain, live, end } = server();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true, draining: false, liveCalls: 0 });
    await ring(app, 'live_a');
    await until(() => live().length === 1);
    const result = drain.start(60_000);
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect([health.statusCode, health.json()]).toEqual([200, { ok: true, draining: true, liveCalls: 1 }]);
    end('live_a');
    await result;
    await app.close();
  });
});

describe('the deploy\'s drain endpoint', () => {
  const ask = (app: ReturnType<typeof buildServer>, auth?: string) => app.inject({ method: 'GET', url: '/internal/drain', headers: auth ? { authorization: auth } : {} });

  it('answers only with the internal token', async () => {
    const { app } = server();
    expect((await ask(app)).statusCode).toBe(401);
    expect((await ask(app, 'Bearer not-the-token-not-the-token-not-the-token')).statusCode).toBe(401);
    expect((await ask(app, TOKEN)).statusCode).toBe(401);
    const ok = await ask(app, `Bearer ${TOKEN}`);
    expect([ok.statusCode, ok.json()]).toEqual([200, { draining: false, liveCalls: 0 }]);
    await app.close();
  });

  it('says whether it is draining and how many calls are live, counts only', async () => {
    const { app, drain, live, end } = server();
    await ring(app, 'live_a');
    await until(() => live().length === 1);
    expect((await ask(app, `Bearer ${TOKEN}`)).json()).toEqual({ draining: false, liveCalls: 1 });
    const result = drain.start(60_000);
    expect((await ask(app, `Bearer ${TOKEN}`)).json()).toEqual({ draining: true, liveCalls: 1 });
    end('live_a');
    await result;
    expect((await ask(app, `Bearer ${TOKEN}`)).json()).toEqual({ draining: true, liveCalls: 0 });
    await app.close();
  });

  it('does not exist without an internal token, like the other internal routes', async () => {
    const { app } = server({ internalToken: undefined });
    expect((await ask(app, `Bearer ${TOKEN}`)).statusCode).toBe(404);
    await app.close();
  });
});

describe('the drain on its own', () => {
  it('starts once: a second start waits on the same drain', async () => {
    let n = 1;
    const cut = vi.fn(async () => { n = 0; });
    const d = new Drain({ liveCalls: () => n, cut, pollMs: 5 });
    const a = d.start(30);
    const b = d.start(60_000);
    expect(a).toBe(b);
    expect(await a).toMatchObject({ end: 'deadline', cut: 1 });
    expect(cut).toHaveBeenCalledTimes(1);
  });

  it('a signal before any wait cuts at once', async () => {
    const d = new Drain({ liveCalls: () => 2, cut: async () => {}, pollMs: 5 });
    d.force();
    expect(await d.start(60_000)).toMatchObject({ end: 'signal', cut: 2 });
  });
});

describe('what a restart says', () => {
  const alerter = () => {
    const notes: string[] = [];
    const a: Alerter = { alert: () => {}, resolved: () => {}, note: (t) => { notes.push(t); }, flush: async () => {} };
    return { a, notes };
  };
  const fake = (live: number, result: DrainResult, away = 0) => ({ liveCalls: () => live, turnedAway: () => away, start: async () => result });

  it('says in Slack how many calls were cut at the deadline', async () => {
    const { a, notes } = alerter();
    await drainForRestart(fake(2, { end: 'deadline', cut: 2, waitedMs: 600_000 }, 3), { log, alerts: a, signal: 'SIGTERM' });
    expect(notes).toEqual([
      'Voice service restarting: waiting for 2 live calls to end (at most 10 minutes). New phone calls go to the backup route meanwhile.',
      'Voice service stopping with 2 calls cut (still live after 10 minutes): our calls heard a goodbye and were hung up; a Vapi call carries on at Vapi without its memory. New calls turned away meanwhile (phone calls to the backup route, test calls refused): 3.',
    ]);
  });

  it('says a second signal cut them', async () => {
    const { a, notes } = alerter();
    await drainForRestart(fake(1, { end: 'signal', cut: 1, waitedMs: 2000 }), { log, alerts: a, signal: 'SIGTERM' });
    expect(notes.at(-1)).toMatch(/^Voice service stopping with 1 call cut \(a second stop signal\)/);
  });

  it('says nothing more than the start note when there was nothing to wait for', async () => {
    const { a, notes } = alerter();
    await drainForRestart(fake(0, { end: 'idle', cut: 0, waitedMs: 0 }), { log, alerts: a, signal: 'SIGTERM' });
    expect(notes).toEqual([]);
  });
});
