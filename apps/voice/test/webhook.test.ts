import { ScriptedPlanner } from '@attendra/agent';
import { DEMO_CLINIC } from '@attendra/core';
import { createLogger } from '@attendra/observability';
import { Writable } from 'node:stream';
import twilio from 'twilio';
import { describe, expect, it, vi } from 'vitest';
import { EngineRouter, type Sideband, type SidebandEvent } from '@attendra/voice-engine';
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

  it('sends a VIP caller to the front desk while it is open, and lets the assistant answer anyone else', async () => {
    const vipClinic = { ...DEMO_CLINIC, vipCallers: [{ name: 'Partner clinic', phone: '+13035550147' }] };
    const run = async (at: string, clinic: typeof DEMO_CLINIC) => {
      const sideband = { send: vi.fn(), onEvent: vi.fn(), onError: vi.fn(), onClose: (h: (code: number) => void) => void setTimeout(() => h(1000), 0), close: vi.fn() };
      const { d, engine } = deps({ clinicForNumber: async () => clinic, now: () => new Date(at) });
      engine.attach.mockReturnValue(sideband);
      const app = buildServer(d);
      await post(app, incoming(`wh_vip_${at}`, '+13035550100'));
      await app.close();
      // the VIP's hello is the opening itself: who is speaking, and that they are being put through
      return JSON.stringify(sideband.send.mock.calls) + JSON.stringify(engine.accept.mock.calls.map((c) => (c as unknown[])[3] ?? null));
    };
    // Tuesday 29 September 2026, 10 am in Denver: open
    expect(await run('2026-09-29T16:00:00Z', vipClinic)).toContain('VIP list');
    expect(await run('2026-09-29T16:00:00Z', vipClinic)).toContain("I'm connecting you with our team now.");
    expect(await run('2026-09-29T16:00:00Z', vipClinic)).not.toContain('How can I help');
    expect(await run('2026-09-29T16:00:00Z', DEMO_CLINIC)).not.toContain('VIP list');
    // 10 pm: the front desk takes no transfers, so the assistant answers as usual
    expect(await run('2026-09-30T04:00:00Z', vipClinic)).not.toContain('VIP list');
  });

  it('rejects a call to a number no clinic owns with SIP 404', async () => {
    const alert = vi.fn();
    const { d, engine } = deps({ alerts: { alert, note: vi.fn(), flush: async () => {} } });
    const app = buildServer(d);
    await post(app, incoming('wh_4', '+19995550000'));
    await app.close();
    expect(engine.reject).toHaveBeenCalledWith('live_abc', 404);
    expect(engine.accept).not.toHaveBeenCalled();
    // the people who run Attendra hear about it from the system, not from a clinic
    expect(alert).toHaveBeenCalledWith('call_rejected', expect.stringContaining('turned away (SIP 404)'));
  });

  it('reads the caller\'s earlier calls before the call runs, and a failed read never holds the call up', async () => {
    const historyFor = vi.fn(async () => { throw new Error('db down'); });
    const { d, engine } = deps({ historyFor });
    const app = buildServer(d);
    await post(app, incoming('wh_hist', '+13035550100'));
    await app.close();
    expect(historyFor).toHaveBeenCalledWith(DEMO_CLINIC.id, '+13035550147', 'call_1');
    expect(engine.attach).toHaveBeenCalledWith('live_abc');
  });

  it('finds the dialled number outside the To header when To holds the project address, and never uses the caller\'s number', async () => {
    const { d, engine } = deps();
    const app = buildServer(d);
    const body = JSON.stringify({ sig: 'ok', id: 'wh_trunk', type: 'live.transport.incoming', data: { type: 'sip', session_id: 'live_trunk', sip_headers: [
      { name: 'From', value: '<sip:+13035550100@x>' },
      { name: 'To', value: '<sip:proj_95nNmlW7FYT7zgRs4Qnr2Yzz@sip.api.openai.com;transport=tls>' },
      { name: 'X-Twilio-Called', value: '+13035550100' },
    ] } });
    await post(app, body);
    await app.close();
    expect(engine.accept).toHaveBeenCalledWith('live_trunk', expect.objectContaining({ id: DEMO_CLINIC.id }), expect.any(Date));
  });

  it('a call to an unknown number is not matched through the caller\'s own number', async () => {
    const { d, engine } = deps();
    const app = buildServer(d);
    const body = JSON.stringify({ sig: 'ok', id: 'wh_from', type: 'live.transport.incoming', data: { type: 'sip', session_id: 'live_from', sip_headers: [
      { name: 'From', value: '<sip:+13035550100@x>' }, { name: 'P-Asserted-Identity', value: '<sip:+13035550100@x>' },
      { name: 'To', value: '<sip:proj_x@sip.api.openai.com>' },
    ] } });
    await post(app, body);
    await app.close();
    expect(engine.reject).toHaveBeenCalledWith('live_from', 404);
    expect(engine.accept).not.toHaveBeenCalled();
  });

  it('answers a call that arrives for both engines once, on GPT-Live, and rejects an unknown one once', async () => {
    const twin = (id: string, type: string, session: string, to: string) => JSON.stringify({ sig: 'ok', id, type, data: { type: 'sip', session_id: session, call_id: session, sip_headers: [{ name: 'To', value: `<sip:${to}@x>` }] } });
    const { d, engine } = deps({ pairWaitMs: 20 });
    const app = buildServer(d);
    await post(app, twin('wh_r1', 'realtime.call.incoming', 'rtc_u1_same', '+13035550100'));
    await post(app, twin('wh_l1', 'live.transport.incoming', 'live_u1_same', '+13035550100'));
    await post(app, twin('wh_r2', 'realtime.call.incoming', 'rtc_u1_none', '+19995550000'));
    await post(app, twin('wh_l2', 'live.transport.incoming', 'live_u1_none', '+19995550000'));
    await app.close();
    expect(engine.accept).toHaveBeenCalledTimes(1);
    expect(engine.accept).toHaveBeenCalledWith('live_u1_same', expect.anything(), expect.any(Date));
    expect(engine.reject).toHaveBeenCalledTimes(1);
    expect(engine.reject).toHaveBeenCalledWith('live_u1_none', 404);
  });

  it('a call that arrives for one engine only is still answered after the short wait', async () => {
    const { d, engine } = deps({ pairWaitMs: 20 });
    const app = buildServer(d);
    await post(app, JSON.stringify({ sig: 'ok', id: 'wh_solo', type: 'realtime.call.incoming', data: { type: 'sip', call_id: 'rtc_u1_solo', sip_headers: [{ name: 'To', value: '<sip:+13035550100@x>' }] } }));
    await app.close();
    expect(engine.accept).toHaveBeenCalledWith('rtc_u1_solo', expect.anything(), expect.any(Date));
  });

  it('answers 429 once one address sends more forged deliveries than the limit, and still takes a signed call from it', async () => {
    const { d, engine } = deps({ webhookRateLimit: 2 });
    const app = buildServer(d);
    const codes = [];
    for (const id of ['wh_9', 'wh_10', 'wh_11']) codes.push((await post(app, incoming(id, '+13035550100', 'forged'))).statusCode);
    // the same address (a proxy, say) with a real call: never turned away
    const real = await post(app, incoming('wh_12', '+13035550100'));
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();
    expect(codes).toEqual([400, 400, 429]);
    expect(real.statusCode).toBe(200);
    expect(engine.accept).toHaveBeenCalled();
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

  it('ends a call sooner when the API asks for less than the usual limit, never later', async () => {
    const { d } = deps({ internalToken: TOKEN });
    const app = buildServer(d);
    expect((await webCall(app, { ...OFFER, maxSeconds: 90 })).json()).toMatchObject({ maxSeconds: 90 });
    expect((await webCall(app, { ...OFFER, maxSeconds: 9000 })).json()).toMatchObject({ maxSeconds: 300 });
    expect((await webCall(app, { ...OFFER, maxSeconds: 0 })).statusCode).toBe(400);
    await app.close();
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
    const call = openSideband();
    engine.attach.mockReturnValue(call.sideband);
    const app = buildServer(d);
    expect((await webCall(app, OFFER)).statusCode).toBe(201);
    await vi.waitFor(() => expect(engine.hangup).toHaveBeenCalledWith('live_web'));
    // the assistant is told why it stops before the line closes
    const sent = vi.mocked(call.sideband.send).mock.calls.map(([m]) => m as { type: string; content?: string });
    expect(sent.some((m) => m.type === 'session.instructions.append' && String(m.content).includes('time limit'))).toBe(true);
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

describe('Twilio text webhooks', () => {
  const TOKEN_T = 'twilio-auth-token';
  const BASE = 'https://voice.example.com';
  const form = (f: Record<string, string>) => new URLSearchParams(f).toString();
  const signed = (path: string, f: Record<string, string>) => twilio.getExpectedTwilioSignature(TOKEN_T, `${BASE}${path}`, f);
  const sms = () => ({
    authToken: TOKEN_T, publicUrl: BASE,
    inbound: vi.fn(async ({ body }: { body: string }) => (/^stop$/i.test(body) ? undefined : 'This number does not read replies.')),
    status: vi.fn(async () => {}),
  });
  const send = (app: ReturnType<typeof buildServer>, path: string, f: Record<string, string>, signature = signed(path, f)) =>
    app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, payload: form(f) });

  it('takes STOP with an empty reply, and answers anything else with the clinic line', async () => {
    const s = sms();
    const app = buildServer(deps({ sms: s }).d);
    const stop = await send(app, '/webhooks/twilio/sms-inbound', { From: '+13035550147', To: '+13035550100', Body: 'STOP' });
    expect(stop.statusCode).toBe(200);
    expect(stop.headers['content-type']).toContain('text/xml');
    expect(stop.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(s.inbound).toHaveBeenCalledWith({ to: '+13035550100', from: '+13035550147', body: 'STOP' });
    const other = await send(app, '/webhooks/twilio/sms-inbound', { From: '+13035550147', To: '+13035550100', Body: 'is my dog ok?' });
    expect(other.body).toContain('<Message>This number does not read replies.</Message>');
  });

  it('refuses a request whose signature does not match, and is off without Twilio', async () => {
    const s = sms();
    const app = buildServer(deps({ sms: s }).d);
    const f = { From: '+13035550147', To: '+13035550100', Body: 'STOP' };
    expect((await send(app, '/webhooks/twilio/sms-inbound', f, 'forged')).statusCode).toBe(403);
    expect((await send(app, '/webhooks/twilio/sms-inbound', { ...f, Body: 'START' }, signed('/webhooks/twilio/sms-inbound', f))).statusCode).toBe(403);
    expect(s.inbound).not.toHaveBeenCalled();
    expect((await send(buildServer(deps().d), '/webhooks/twilio/sms-inbound', f)).statusCode).toBe(503);
  });

  it('queues a delivery report for the clinic in the query', async () => {
    const s = sms();
    const app = buildServer(deps({ sms: s }).d);
    const path = `/webhooks/twilio/sms-status?clinic=${DEMO_CLINIC.id}`;
    const sid = `SM${'c'.repeat(32)}`;
    expect((await send(app, path, { MessageSid: sid, MessageStatus: 'undelivered', ErrorCode: '30007' })).statusCode).toBe(204);
    expect(s.status).toHaveBeenCalledWith({ clinicId: DEMO_CLINIC.id, messageSid: sid, status: 'undelivered', errorCode: '30007' });
    expect((await send(app, path, { MessageSid: 'nope', MessageStatus: 'sent' })).statusCode).toBe(400);
  });

  it('says a Twilio spend alert in Slack, signed only', async () => {
    const alert = vi.fn();
    const app = buildServer({ ...deps({ sms: sms() }).d, alerts: { alert, note: vi.fn(), flush: async () => {} } });
    const f = { UsageTriggerSid: `UT${'a'.repeat(32)}`, UsageCategory: 'sms', CurrentValue: '10.42', TriggerValue: '10' };
    expect((await send(app, '/webhooks/twilio/spend-alert', f, 'forged')).statusCode).toBe(403);
    expect(alert).not.toHaveBeenCalled();
    expect((await send(app, '/webhooks/twilio/spend-alert', f)).statusCode).toBe(204);
    expect(alert).toHaveBeenCalledWith('spend_sms', expect.stringContaining('Twilio spend today on texts is $10.42, past the $10.00 alert'));
    expect((await send(app, '/webhooks/twilio/spend-alert', { ...f, UsageTriggerSid: 'nope' })).statusCode).toBe(400);
  });
});

describe('two engines: GPT-Live and the Realtime API', () => {
  const fake = (name: string) => ({
    name, accept: vi.fn(async () => {}), startBrowserCall: vi.fn(async () => ({ sessionId: `${name}_web`, sdpAnswer: 'v=0' })), reject: vi.fn(async () => {}), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}), release: vi.fn(),
    attach: vi.fn((): Sideband => ({ send: vi.fn(), onEvent: vi.fn(), onError: vi.fn(), onClose: (h) => void setTimeout(() => h(1000), 0), close: vi.fn() })),
  });
  const realtimeCall = (id: string) => JSON.stringify({
    sig: 'ok', id, type: 'realtime.call.incoming',
    data: { call_id: 'rtc_1', sip_headers: [{ name: 'To', value: '<sip:+13035550100@sip.api.openai.com>' }, { name: 'From', value: '<sip:+13035550147@x>' }] },
  });

  it('answers a Realtime call with the Realtime engine, and a GPT-Live call with GPT-Live', async () => {
    const live = fake('gpt-live');
    const realtime = fake('gpt-realtime');
    const { d } = deps({ engine: new EngineRouter({ 'gpt-live': live, 'gpt-realtime': realtime }, 'gpt-live'), pairWaitMs: 20 });
    const app = buildServer(d);
    await post(app, realtimeCall('wh_rt_1'));
    await post(app, incoming('wh_rt_2', '+13035550100'));
    await app.close();
    expect(realtime.accept).toHaveBeenCalledWith('rtc_1', expect.objectContaining({ id: DEMO_CLINIC.id }), expect.any(Date));
    expect(realtime.attach).toHaveBeenCalledWith('rtc_1');
    expect(live.accept).toHaveBeenCalledWith('live_abc', expect.anything(), expect.any(Date));
  });

  it('starts a test call with the engine the clinic was given', async () => {
    const live = fake('gpt-live');
    const realtime = fake('gpt-realtime');
    const router = new EngineRouter({ 'gpt-live': live, 'gpt-realtime': realtime }, 'gpt-live');
    await router.startBrowserCall({ ...DEMO_CLINIC, voiceEngine: 'gpt-realtime' }, 'v=0 offer', new Date());
    await router.hangup('gpt-realtime_web');
    expect(realtime.startBrowserCall).toHaveBeenCalled();
    expect(realtime.hangup).toHaveBeenCalledWith('gpt-realtime_web');
    await router.startBrowserCall(DEMO_CLINIC, 'v=0 offer', new Date());
    expect(live.startBrowserCall).toHaveBeenCalled();
  });
});
