import { ClinicConfig, DEMO_BUSY_LINE, DEMO_GOODBYE_LINE, DEMO_LIMITS, DEMO_WRAP_UP_LINE, type DemoLimitCode, RIVERBEND_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, seedRiverbend } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerVapi } from '../src/vapi';

// A demo clinic's limits on the Vapi path (2026-11-16): the same check when its phone call opens; over a limit, Vapi says
// the one fixed line word for word and the call ends (within 10 s whatever Vapi's assistant does), its tools refused;
// under them, a polite line at 14:00 and the end at 15:00. A clinic that is not a demo clinic never meets any of it.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const TEST_SECRET = 'a-vapi-shared-secret-for-the-tests-only-0123456789';
const CONTROL = 'https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-d/control';
const CALLER = '+17205550147';

describe('a demo clinic on Vapi', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  let clinic = ClinicConfig.parse({ ...RIVERBEND_CLINIC, demoClinic: { enabled: true, baselineAt: null } });
  const controls: Record<string, unknown>[] = [];
  const scheduled: { ms: number; fn: () => void }[] = [];
  const demoLimitFor = vi.fn(async (): Promise<DemoLimitCode | null> => null);

  beforeAll(async () => {
    t = await openTestDatabase();
    const cipher = createPhiCipher(TEST_DATA_KEY);
    await seedRiverbend(t.db, cipher);
    const calls = new CallRepository(t.db, cipher);
    registerVapi(app, {
      testSecret: TEST_SECRET, secretMatches: async () => false, maxConcurrency: 4,
      fetch: (async (_url: string, init: { body: string }) => { controls.push(JSON.parse(init.body) as Record<string, unknown>); return new Response('{}'); }) as unknown as typeof fetch,
      later: (ms, fn) => { scheduled.push({ ms, fn }); },
      clinicById: async (id) => (id === clinic.id ? clinic : null),
      openCall: (clinicId, sessionId, from, channel, startedBy, last4, how) => calls.open(clinicId, sessionId, from, channel, startedBy, last4, how),
      recorderFor: (clinicId, callId) => ({ appendSegment: (s) => calls.appendSegment(clinicId, callId, s), close: (c) => calls.close(clinicId, callId, c) }),
      actionsFor: (clinicId, callId) => ({ record: (a) => calls.recordAction(clinicId, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, taskRevision: a.revision, patientId: a.patientId }) }),
      backend: {
        patients: new PostgresPatientDirectory(t.db, cipher), scheduler: new BuiltinScheduler(t.db), tasks: new PostgresTaskQueue(t.db, cipher),
        audit: new PostgresAuditLog(t.db), messenger: { sendTemplate: async () => ({ status: 'sent' as const, messageId: 'sms-1' }) },
      },
      planner: { plan: async () => { throw new Error('the Vapi path never asks the planner'); } }, log, now: () => new Date(), demoLimitFor,
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await t.close(); });

  const post = (message: unknown) => app.inject({
    method: 'POST', url: `/webhooks/vapi/v1/events?clinic=${clinic.id}`, headers: { 'content-type': 'application/json', 'x-vapi-secret': TEST_SECRET }, payload: JSON.stringify({ message }),
  });
  const phone = (id: string) => ({ id, type: 'inboundPhoneCall', customer: { number: CALLER }, monitor: { controlUrl: CONTROL } });
  const reset = () => { controls.length = 0; scheduled.length = 0; demoLimitFor.mockReset(); demoLimitFor.mockResolvedValue(null); };
  // the owner's connection, for reading what was recorded
  const actionsOf = async (sessionId: string) => (await t.client.query<{ tool: string; result: unknown }>(
    'select a.tool, a.result from call_actions a join calls c on c.id = a.call_id where c.clinic_id = $1 and c.openai_session_id = $2', [clinic.id, sessionId])).rows;

  it('over a limit: the busy line word for word, ended after it and within 10 s, tools refused, the code recorded', async () => {
    reset();
    demoLimitFor.mockResolvedValue('demo_caller_calls');
    expect((await post({ type: 'status-update', status: 'in-progress', call: phone('vapi-demo-1') })).statusCode).toBe(200);
    expect(demoLimitFor).toHaveBeenCalledWith(expect.objectContaining({ id: clinic.id }), CALLER);
    expect(controls[0]).toEqual({ type: 'say', content: DEMO_BUSY_LINE.en, interruptAssistantEnabled: true, endCallAfterSpoken: true });
    expect(scheduled.map((s) => s.ms)).toEqual([10_000]);
    scheduled[0]!.fn();
    await vi.waitFor(() => expect(controls.at(-1)).toEqual({ type: 'end-call' }));
    // no call facts for a call that is turned away, and nothing it says is acted on
    expect(JSON.stringify(controls)).not.toContain('add-message');
    const tools = await post({ type: 'tool-calls', call: phone('vapi-demo-1'), toolCallList: [{ id: 'tc1', function: { name: 'get_clinic_info', arguments: '{}' } }] });
    expect(tools.json()).toEqual({ results: [{ toolCallId: 'tc1', error: 'This call cannot be helped here.' }] });
    await vi.waitFor(async () => expect(await actionsOf('vapi_vapi-demo-1')).toContainEqual({ tool: 'demo_limit', result: { code: 'demo_caller_calls' } }));
  });

  it('a line still waiting for its control URL is said as soon as Vapi sends one', async () => {
    reset();
    demoLimitFor.mockResolvedValue('demo_clinic_minutes');
    await post({ type: 'status-update', status: 'in-progress', call: { id: 'vapi-demo-2', type: 'inboundPhoneCall', customer: { number: CALLER } } });
    expect(controls).toEqual([]);
    await post({ type: 'conversation-update', call: phone('vapi-demo-2'), messages: [] });
    expect(controls[0]).toMatchObject({ type: 'say', content: DEMO_BUSY_LINE.en, endCallAfterSpoken: true });
  });

  it('under the limits: a polite line at 14:00, the goodbye at 15:00, and the end', async () => {
    reset();
    await post({ type: 'status-update', status: 'in-progress', call: phone('vapi-demo-3') });
    expect(demoLimitFor).toHaveBeenCalledTimes(1);
    expect(scheduled.map((s) => s.ms)).toEqual([DEMO_LIMITS.wrapUpAtSeconds * 1000, DEMO_LIMITS.callSeconds * 1000, DEMO_LIMITS.callSeconds * 1000 + 15_000]);
    const before = controls.length;
    for (const s of scheduled) s.fn();
    await vi.waitFor(() => expect(controls.length).toBe(before + 3));
    expect(controls.slice(before)).toEqual([
      { type: 'say', content: DEMO_WRAP_UP_LINE.en },
      { type: 'say', content: DEMO_GOODBYE_LINE.en, interruptAssistantEnabled: true, endCallAfterSpoken: true },
      { type: 'end-call' },
    ]);
  });

  it('a browser call to it, and a clinic that is not a demo clinic, never meet the limits or the time limit', async () => {
    reset();
    await post({ type: 'status-update', status: 'in-progress', call: { id: 'vapi-demo-web', type: 'webCall', monitor: { controlUrl: CONTROL } } });
    expect(demoLimitFor).not.toHaveBeenCalled();
    expect(scheduled).toEqual([]);
    clinic = ClinicConfig.parse({ ...RIVERBEND_CLINIC });
    demoLimitFor.mockResolvedValue('demo_caller_calls');
    await post({ type: 'status-update', status: 'in-progress', call: phone('vapi-normal-1') });
    expect(demoLimitFor).not.toHaveBeenCalled();
    expect(scheduled).toEqual([]);
    expect(JSON.stringify(controls)).not.toContain(DEMO_BUSY_LINE.en);
  });
});
