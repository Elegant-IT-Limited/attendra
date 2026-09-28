import { ScriptedPlanner } from '@attendra/agent';
import { DEMO_CLINIC } from '@attendra/core';
import { createLogger } from '@attendra/observability';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { buildServer, type IncomingCall, type VoiceDeps } from '../src/server';

const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });

function deps(over: Partial<VoiceDeps> = {}) {
  const seen = new Set<string>();
  const engine = {
    name: 'fake', accept: vi.fn(async () => {}), reject: vi.fn(async () => {}), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}),
    attach: vi.fn(() => ({ send: vi.fn(), onEvent: vi.fn(), onError: vi.fn(), onClose: (h: (c: number) => void) => setTimeout(() => h(1000), 0), close: vi.fn() })),
  } satisfies VoiceDeps['engine'];
  const d: VoiceDeps = {
    verifyWebhook: async (raw) => { const e = JSON.parse(raw) as IncomingCall & { sig?: string }; if (e.sig !== 'ok') throw new Error('bad'); return e; },
    claimDelivery: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    clinicForNumber: async (n) => (n === '+13035550100' ? DEMO_CLINIC : null),
    openCall: async () => 'call_1',
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
});
