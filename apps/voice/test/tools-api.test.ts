import { ClinicConfig, DEMO_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import type { Sideband, SidebandEvent, VoiceEngine } from '@attendra/voice-engine';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer, type VoiceDeps } from '../src/server';
import { mintToolToken, readToolToken } from '../src/tool-tokens';

// Batch 1a: a clinic switched to the tools path. Its calls are set up with the flow, recorded with their engine and
// flow, and answered through the tools API, on the sideband and over HTTP with the call's own token.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const TOKEN = 'a-long-internal-token-for-the-tests-only';
const clinic = ClinicConfig.parse({ ...DEMO_CLINIC, voiceFlow: 'tools' });

describe('the tools API over HTTP', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  let app: ReturnType<typeof buildServer>;
  const handlers: ((e: SidebandEvent) => void)[] = [];
  const closers: ((code: number) => void)[] = [];
  const started = vi.fn();
  const engine: VoiceEngine = {
    name: 'gpt-realtime',
    accept: vi.fn(async () => {}),
    startBrowserCall: async (_c, _sdp, _now, opts) => { started(opts); return { sessionId: 'rtc_tools_1', sdpAnswer: 'v=0 answer' }; },
    reject: vi.fn(async () => {}), transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}),
    attach: (): Sideband => ({ send: () => {}, onEvent: (h) => { handlers.push(h); }, onError: () => {}, onClose: (h) => { closers.push(h); }, close: () => {} }),
  };

  beforeAll(async () => {
    t = await openTestDatabase();
    const cipher = createPhiCipher(TEST_DATA_KEY);
    await seedDemo(t.db, cipher);
    const calls = new CallRepository(t.db, cipher);
    const deps: VoiceDeps = {
      verifyWebhook: async () => { throw new Error('no webhooks here'); },
      claimDelivery: async () => true,
      clinicForNumber: async () => clinic,
      clinicById: async (id) => (id === clinic.id ? clinic : null),
      openCall: (clinicId, sessionId, from, channel, startedBy, last4, how) => calls.open(clinicId, sessionId, from, channel, startedBy, last4, how),
      recorderFor: (clinicId, callId) => ({ appendSegment: (s) => calls.appendSegment(clinicId, callId, s), close: (c) => calls.close(clinicId, callId, c) }),
      actionsFor: () => ({ record: async () => {} }),
      engine,
      backend: {
        patients: new PostgresPatientDirectory(t.db, cipher), scheduler: new BuiltinScheduler(t.db), tasks: new PostgresTaskQueue(t.db, cipher),
        audit: new PostgresAuditLog(t.db), messenger: { sendTemplate: async () => ({ status: 'sent' as const, messageId: 'sms-1' }) },
      },
      planner: { plan: async () => { throw new Error('the tools path never asks the planner'); } },
      log, internalToken: TOKEN,
    };
    app = buildServer(deps);
    await app.ready();
  });
  afterAll(async () => { await app.close(); await t.close(); });

  it('sets the call up on the tools path, records its engine and flow, and answers a tool with the call\'s own token only', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/web-calls', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, payload: JSON.stringify({ clinicId: clinic.id, userId: 'user_1', sdp: 'v=0 offer' }) });
    expect(res.statusCode).toBe(201);
    const { callId } = res.json() as { callId: string };
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ flow: 'tools' }));
    const rows = async (q: string) => { await t.client.query(`select set_config('app.clinic_id', $1, false)`, [clinic.id]); return (await t.client.query(q, [callId])).rows; };
    expect(await rows('select engine, voice_flow as flow from calls where id = $1')).toEqual([{ engine: 'gpt-realtime', flow: 'tools' }]);

    const token = (app as unknown as { toolTokenFor(id: string): string | null }).toolTokenFor(callId)!;
    expect(readToolToken(TOKEN, token)).toMatchObject({ callId, clinicId: clinic.id });
    const call = (bearer: string | null, tool = 'clinic_now', body: unknown = { call_id: 'fc_1', arguments: {} }) =>
      app.inject({ method: 'POST', url: `/tools/v1/${tool}`, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    const ok = await call(token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, outcome: 'ok', data: { zone: clinic.timezone } });
    // the same tool call again is answered once
    expect((await call(token)).statusCode).toBe(409);
    // no token, the service's own token, a forged one, another call's: refused
    expect((await call(null)).statusCode).toBe(401);
    expect((await call(TOKEN)).statusCode).toBe(401);
    expect((await call(mintToolToken('another-key-of-the-same-length-or-more', { callId, clinicId: clinic.id, expiresAt: Date.now() + 60_000 }))).statusCode).toBe(401);
    expect((await call(mintToolToken(TOKEN, { callId: '00000000-0000-0000-0000-000000000000', clinicId: clinic.id, expiresAt: Date.now() + 60_000 }))).statusCode).toBe(401);
    // a tool the voice does not have is refused by the agent, with its reason
    expect((await call(token, 'drop_tables', { call_id: 'fc_2', arguments: {} })).json()).toMatchObject({ ok: false, outcome: 'unknown_tool' });

    // the call ends: its token is no good any more
    for (const h of handlers) h({ type: 'session.closed', event_id: 'end_1', reason: 'remote_hangup', usage: { seconds: 12 } });
    for (const c of closers) c(1000);
    await vi.waitFor(async () => expect((await call(token, 'clinic_now', { call_id: 'fc_3', arguments: {} })).statusCode).toBe(401));
    await vi.waitFor(async () => expect(await rows('select engine, texts from call_costs where call_id = $1')).toEqual([{ engine: 'gpt-realtime', texts: 0 }]));
  });

  it('refuses an expired or malformed token', () => {
    expect(readToolToken(TOKEN, mintToolToken(TOKEN, { callId: 'c', clinicId: 'k', expiresAt: Date.now() - 1 }))).toBeNull();
    expect(readToolToken(TOKEN, 'not.a.token')).toBeNull();
    expect(readToolToken(TOKEN, undefined)).toBeNull();
  });
});
