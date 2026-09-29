import { ScriptedPlanner } from '@attendra/agent';
import { DEMO_CLINIC } from '@attendra/core';
import { createLogger } from '@attendra/observability';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Sideband, SidebandEvent } from '@attendra/voice-engine';
import { buildServer, type IncomingCall, type VoiceDeps } from '../src/server';

const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });

function deps(over: Partial<VoiceDeps> = {}) {
  const seen = new Set<string>();
  const engine = {
    name: 'fake', accept: vi.fn(async () => {}), startBrowserCall: vi.fn(async () => ({ sessionId: 'live_web', sdpAnswer: 'v=0 answer' })), reject: vi.fn(async () => {}), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}), release: vi.fn(),
    attach: vi.fn((): Sideband => ({ send: vi.fn(), onEvent: vi.fn(), onError: vi.fn(), onClose: (h) => void setTimeout(() => h(1000), 0), close: vi.fn() })),
  } satisfies VoiceDeps['engine'];
  const d: VoiceDeps = {
    verifyWebhook: async (raw) => { const e = JSON.parse(raw) as IncomingCall & { sig?: string }; if (e.sig !== 'ok') throw new Error('bad'); return e; },
    claimDelivery: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    clinicForNumber: async (n) => (n === '+13035550100' ? DEMO_CLINIC : null),
    clinicById: async (id) => (id === DEMO_CLINIC.id ? DEMO_CLINIC : null),
    openCall: vi.fn(async () => 'call_1'),
    recorderFor: () => ({ appendSegment: async () => {}, close: async () => {} }),
    actionsFor: () => ({ record: async () => {} }),
    engine, backend: {} as never, planner: new ScriptedPlanner([]), log,
    ...over,
  };
  return { d, engine };
}

const incoming = (id: string, to: string, sig = 'ok') => JSON.stringify({
  sig, id, type: 'live.transport.incoming',
  data: { type: 'sip', session_id: 'live_abc', sip_headers: [{ name: 'To', value: `<sip:${to}@sip.api.openai.com>` }, { name: 'From', value: '<sip:+13035550147@x>' }] },
});
const post = (app: ReturnType<typeof buildServer>, body: string) =>
  app.inject({ method: 'POST', url: '/webhooks/openai', headers: { 'content-type': 'application/json' }, payload: body });

describe('the OpenAI webhook', () => {
  it('refuses a delivery whose signature does not verify', async () => {
    const { d, engine } = deps();
    const res = await post(buildServer(d), incoming('wh_1', '+13035550100', 'forged'));
    expect(res.statusCode).toBe(400);
    expect(engine.accept).not.toHaveBeenCalled();
  });

  it('accepts a call to a known clinic number and attaches the sideband', async () => {
    const { d, engine } = deps();
    const app = buildServer(d);
    expect((await post(app, incoming('wh_2', '+13035550100'))).statusCode).toBe(200);
    await app.close();
    expect(engine.accept).toHaveBeenCalledWith('live_abc', expect.objectContaining({ id: DEMO_CLINIC.id }), expect.any(Date));
    expect(engine.attach).toHaveBeenCalledWith('live_abc');
  });

  it('handles a retried delivery once', async () => {
    const { d, engine } = deps();
    const app = buildServer(d);
    await post(app, incoming('wh_3', '+13035550100'));
    const again = await post(app, incoming('wh_3', '+13035550100'));
    await app.close();
    expect(again.json()).toEqual({ duplicate: true });
    expect(engine.accept).toHaveBeenCalledTimes(1);
  });

  it('treats the deprecated event for the same session as a duplicate, not a second accept', async () => {
    const { d, engine } = deps();
    const app = buildServer(d);
    await post(app, incoming('wh_5', '+13035550100'));
    await post(app, incoming('wh_6', '+13035550100').replace('live.transport.incoming', 'live.call.incoming'));
    await app.close();
    expect(engine.accept).toHaveBeenCalledTimes(1);
  });

  it('rejects with 503 instead of leaving dead air when setup fails before accepting', async () => {
    const { d, engine } = deps({ clinicForNumber: async () => ({ id: 'broken' }) }); // fails ClinicConfig validation
    const app = buildServer(d);
    await post(app, incoming('wh_7', '+13035550100'));
    await app.close();
    expect(engine.reject).toHaveBeenCalledWith('live_abc', 503);
  });

  it('hangs up when setup fails after the call was accepted', async () => {
    const { d, engine } = deps({ openCall: async () => { throw new Error('db down'); } });
    const app = buildServer(d);
    await post(app, incoming('wh_8', '+13035550100'));
    await app.close();
    expect(engine.hangup).toHaveBeenCalledWith('live_abc');
  });

  it('rejects a call to a number no clinic owns with SIP 404', async () => {
    const { d, engine } = deps();
    const app = buildServer(d);
    await post(app, incoming('wh_4', '+19995550000'));
    await app.close();
    expect(engine.reject).toHaveBeenCalledWith('live_abc', 404);
    expect(engine.accept).not.toHaveBeenCalled();
  });

  it('answers 429 once one address sends more than the limit, and leaves the health check alone', async () => {
    const { d } = deps({ webhookRateLimit: 2 });
    const app = buildServer(d);
    const codes = [];
    for (const id of ['wh_9', 'wh_10', 'wh_11']) codes.push((await post(app, incoming(id, '+13035550100', 'forged'))).statusCode);
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();
    expect(codes).toEqual([400, 400, 429]);
    expect(health.statusCode).toBe(200);
  });
});

const TOKEN = 'internal-token-for-tests-0123456789abcdef';
const OFFER = { clinicId: DEMO_CLINIC.id, userId: 'user_ana', sdp: 'v=0 offer' };
const internal = (app: ReturnType<typeof buildServer>, url: string, body: unknown, token = TOKEN) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify(body) });
const webCall = (app: ReturnType<typeof buildServer>, body: unknown, token = TOKEN) => internal(app, '/internal/web-calls', body, token);
/** A sideband that stays open until the test closes it. */
function openSideband(): { sideband: Sideband; drop: (code?: number) => void; emit: (e: { type: string; event_id: string }) => void } {
  let close: (code: number) => void = () => {};
  let emit: (e: { type: string; event_id: string }) => void = () => {};
  const sideband: Sideband = { send: vi.fn(), onEvent: vi.fn((h: (e: SidebandEvent) => void) => { const prev = emit; emit = (e) => { prev(e); h(e); }; }), onError: vi.fn(), onClose: vi.fn((h: (c: number) => void) => { close = h; }), close: vi.fn() };
  return { sideband, drop: (code = 1006) => close(code), emit: (e: { type: string; event_id: string }) => emit(e) };
}

describe('browser test calls', () => {
  it('does not exist without an internal token', async () => {
    const { d } = deps();
    expect((await webCall(buildServer(d), OFFER)).statusCode).toBe(404);
  });

  it('refuses a caller without the token', async () => {
    const { d, engine } = deps({ internalToken: TOKEN });
    expect((await webCall(buildServer(d), OFFER, 'wrong')).statusCode).toBe(401);
    expect(engine.startBrowserCall).not.toHaveBeenCalled();
  });

  it('starts the session, records an audited web call and runs it like a phone call', async () => {
    const { d, engine } = deps({ internalToken: TOKEN });
    const app = buildServer(d);
    const res = await webCall(app, OFFER);
    await app.close();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ callId: 'call_1', sdp: 'v=0 answer', maxSeconds: 300 });
    expect(engine.startBrowserCall).toHaveBeenCalledWith(expect.objectContaining({ id: DEMO_CLINIC.id }), 'v=0 offer', expect.any(Date));
    expect(d.openCall).toHaveBeenCalledWith(DEMO_CLINIC.id, 'live_web', null, 'web', 'user_ana');
    expect(engine.attach).toHaveBeenCalledWith('live_web');
    expect(engine.release).toHaveBeenCalledWith('live_web');
  });

  it('answers 404 for an unknown clinic, 400 for a bad body and 500 for broken settings', async () => {
    const { d } = deps({ internalToken: TOKEN });
    const app = buildServer(d);
    expect((await webCall(app, { ...OFFER, clinicId: 'nope' })).statusCode).toBe(404);
    expect((await webCall(app, { clinicId: DEMO_CLINIC.id, sdp: 'v=0' })).statusCode).toBe(400);
    await app.close();
    const broken = buildServer(deps({ internalToken: TOKEN, clinicById: async () => ({ id: 'broken' }) }).d);
    expect((await webCall(broken, OFFER)).json()).toEqual({ error: 'invalid_clinic_config' });
  });

  it('ends the session when the call cannot be recorded', async () => {
    const { d, engine } = deps({ internalToken: TOKEN, openCall: async () => { throw new Error('db down'); } });
    const app = buildServer(d);
    const res = await webCall(app, OFFER);
    await app.close();
    expect(res.statusCode).toBe(500);
    expect(engine.hangup).toHaveBeenCalledWith('live_web');
  });

  it('allows two open test calls per clinic, and frees the slot when one ends', async () => {
    const { d, engine } = deps({ internalToken: TOKEN });
    const calls = [openSideband(), openSideband()];
    engine.attach.mockReturnValueOnce(calls[0]!.sideband).mockReturnValueOnce(calls[1]!.sideband);
    const app = buildServer(d);
    expect((await webCall(app, OFFER)).statusCode).toBe(201);
    expect((await webCall(app, OFFER)).statusCode).toBe(201);
    const third = await webCall(app, OFFER);
    expect([third.statusCode, third.json()]).toEqual([429, { error: 'test_call_limit' }]);
    calls[0]!.emit({ type: 'session.closed', event_id: 'e1' });
    calls[0]!.drop(1000);
    await vi.waitFor(async () => expect((await webCall(app, OFFER)).statusCode).toBe(201));
  });

  it('ends a test call that runs past its time limit', async () => {
    const { d, engine } = deps({ internalToken: TOKEN, browserCallMaxSeconds: 0.05 });
    engine.attach.mockReturnValue(openSideband().sideband);
    const app = buildServer(d);
    expect((await webCall(app, OFFER)).statusCode).toBe(201);
    await vi.waitFor(() => expect(engine.hangup).toHaveBeenCalledWith('live_web'));
  });

  it('ends the browser session when our sideband drops before it closed', async () => {
    const { d, engine } = deps({ internalToken: TOKEN });
    const call = openSideband();
    engine.attach.mockReturnValue(call.sideband);
    const app = buildServer(d);
    await webCall(app, OFFER);
    expect(engine.hangup).not.toHaveBeenCalled();
    call.drop();
    await app.close();
    expect(engine.hangup).toHaveBeenCalledWith('live_web');
  });

  it('ends a call on request, for that clinic only', async () => {
    const { d, engine } = deps({ internalToken: TOKEN });
    engine.attach.mockReturnValue(openSideband().sideband);
    const app = buildServer(d);
    await webCall(app, OFFER);
    expect((await internal(app, '/internal/web-calls/call_1/end', { clinicId: 'clinic_other' })).statusCode).toBe(404);
    expect(engine.hangup).not.toHaveBeenCalled();
    expect((await internal(app, '/internal/web-calls/call_1/end', { clinicId: DEMO_CLINIC.id })).statusCode).toBe(202);
    expect(engine.hangup).toHaveBeenCalledWith('live_web');
    expect((await internal(app, '/internal/web-calls/call_1/end', { clinicId: DEMO_CLINIC.id }, 'wrong')).statusCode).toBe(401);
  });

  it('refuses a time limit that would switch the limit off', () => {
    expect(() => buildServer(deps({ browserCallMaxSeconds: Number.NaN }).d)).toThrow('browserCallMaxSeconds');
    expect(() => buildServer(deps({ browserCallMaxSeconds: 0 }).d)).toThrow('browserCallMaxSeconds');
  });
});
