import { ClinicConfig, RIVERBEND_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, seedRiverbend } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerVapi } from '../src/vapi';

// Path C of the bake-off (batch 1a, round 2): a Vapi assistant whose tools are ours. Same agent, same rules, its own
// engine on the call row. Made-up demo data only.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const SECRET = 'a-vapi-shared-secret-for-the-tests-only-0123456789';
const clinic = ClinicConfig.parse({ ...RIVERBEND_CLINIC, afterHours: 'book' });

describe('path C: Vapi calling our tools', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => done(null, body));

  beforeAll(async () => {
    t = await openTestDatabase();
    const cipher = createPhiCipher(TEST_DATA_KEY);
    await seedRiverbend(t.db, cipher);
    const calls = new CallRepository(t.db, cipher);
    registerVapi(app, {
      secret: SECRET, clinicById: async (id) => (id === clinic.id ? clinic : null),
      openCall: (clinicId, sessionId, from, channel, startedBy, last4, how) => calls.open(clinicId, sessionId, from, channel, startedBy, last4, how),
      recorderFor: (clinicId, callId) => ({ appendSegment: (s) => calls.appendSegment(clinicId, callId, s), close: (c) => calls.close(clinicId, callId, c) }),
      actionsFor: (clinicId, callId) => ({ record: (a) => calls.recordAction(clinicId, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, taskRevision: a.revision, patientId: a.patientId }) }),
      backend: {
        patients: new PostgresPatientDirectory(t.db, cipher), scheduler: new BuiltinScheduler(t.db), tasks: new PostgresTaskQueue(t.db, cipher),
        audit: new PostgresAuditLog(t.db), messenger: { sendTemplate: async () => ({ status: 'sent' as const, messageId: 'sms-1' }) },
      },
      planner: { plan: async () => { throw new Error('path C never asks the planner'); } }, log, now: () => new Date(),
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await t.close(); });

  const post = (message: unknown, secret: string | null = SECRET, clinicId = clinic.id) => app.inject({
    method: 'POST', url: `/webhooks/vapi/v1/events?clinic=${clinicId}`, headers: { 'content-type': 'application/json', ...(secret ? { 'x-vapi-secret': secret } : {}) }, payload: JSON.stringify({ message }),
  });
  const call = { id: 'vapi-call-1', type: 'webCall' };

  it('refuses a request without the secret', async () => {
    expect((await post({ type: 'tool-calls', call, toolCallList: [] }, null)).statusCode).toBe(401);
    expect((await post({ type: 'tool-calls', call, toolCallList: [] }, 'wrong-secret')).statusCode).toBe(401);
  });

  it('answers Vapi\'s tool calls with our tools, keeps its conversation, and records the call as engine vapi', async () => {
    const res = await post({ type: 'tool-calls', call, toolCallList: [{ id: 'tc_1', function: { name: 'clinic_now', arguments: {} } }] });
    expect(res.statusCode).toBe(200);
    const [r] = (res.json() as { results: { toolCallId: string; result: string }[] }).results;
    expect(r!.toolCallId).toBe('tc_1');
    expect(JSON.parse(r!.result)).toMatchObject({ ok: true, outcome: 'ok', data: { zone: clinic.timezone } });

    // the number read back, and a yes split from a "hello?", from Vapi's own conversation
    await post({ type: 'conversation-update', call, messages: [
      { role: 'bot', message: clinic.greeting, secondsFromStart: 0 },
      { role: 'user', message: 'I need a checkup for my dog. The number is 720 555 0172.', secondsFromStart: 4 },
    ] });
    const asked = await post({ type: 'tool-calls', call, toolCallList: [{ id: 'tc_2', function: { name: 'verify_caller', arguments: JSON.stringify({ owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' }) } }] });
    expect(JSON.parse((asked.json() as { results: { result: string }[] }).results[0]!.result)).toMatchObject({ outcome: 'confirm_number' });
    await post({ type: 'conversation-update', call, messages: [
      { role: 'bot', message: clinic.greeting, secondsFromStart: 0 },
      { role: 'user', message: 'I need a checkup for my dog. The number is 720 555 0172.', secondsFromStart: 4 },
      { role: 'bot', message: "That's 720-555-0172?", secondsFromStart: 8 },
      { role: 'user', message: 'Yes. Hello?', secondsFromStart: 11 },
    ] });
    const named = await post({ type: 'tool-calls', call, toolCallList: [{ id: 'tc_3', function: { name: 'verify_caller', arguments: { owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' } } }] });
    expect(JSON.parse((named.json() as { results: { result: string }[] }).results[0]!.result).outcome).toBe('owner_check');

    await post({ type: 'end-of-call-report', call, endedReason: 'customer-ended-call', durationSeconds: 42, cost: 0.0912 });
    await t.client.query(`select set_config('app.clinic_id', $1, false)`, [clinic.id]);
    const rows = (await t.client.query(`select c.engine, c.voice_flow, c.channel, c.voice_seconds, (select count(*)::int from call_segments s where s.call_id = c.id) as lines, (select engine from call_costs k where k.call_id = c.id) as cost_engine, (select voice_usd from call_costs k where k.call_id = c.id) as voice_usd from calls c where c.openai_session_id = 'vapi_vapi-call-1'`)).rows;
    expect(rows).toEqual([{ engine: 'vapi', voice_flow: 'tools', channel: 'web', voice_seconds: '42.00', lines: 4, cost_engine: 'vapi', voice_usd: '0.091200' }]);
  });

  it('refuses a clinic it does not know, as a result Vapi can say', async () => {
    const res = await post({ type: 'tool-calls', call: { id: 'vapi-call-2', type: 'webCall' }, toolCallList: [{ id: 'tc_9', function: { name: 'clinic_now', arguments: {} } }] }, SECRET, 'clinic_unknown');
    expect(res.json()).toEqual({ results: [{ toolCallId: 'tc_9', error: 'This call cannot be helped here.' }] });
  });
});
