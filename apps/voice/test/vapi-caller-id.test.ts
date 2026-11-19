import { ClinicConfig, RIVERBEND_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, seedRiverbend } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callerIdCorrection, registerVapi, wrongCallerIdDigits } from '../src/vapi';

// V2 (2026-11-17): on a Vapi call from a number ending 0090 the assistant asked about "the number you're calling from,
// ending 0 0 9 2": the digits came from the model's memory of the call facts, said once at the start. Now every identity
// answer that does not end the check carries the caller ID's last four, ours, and a line that says other digits for it
// is corrected at once. Made-up demo data only (555-01xx); nothing here reaches Vapi.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const SECRET = 'a-vapi-shared-secret-for-the-callerid-tests-012345';
const CONTROL = 'https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-live/control';
const clinic = ClinicConfig.parse({ ...RIVERBEND_CLINIC, afterHours: 'book' });

describe('the caller ID\'s digits on a Vapi call', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  const controls: Record<string, unknown>[] = [];

  beforeAll(async () => {
    t = await openTestDatabase();
    const cipher = createPhiCipher(TEST_DATA_KEY);
    await seedRiverbend(t.db, cipher);
    const calls = new CallRepository(t.db, cipher);
    registerVapi(app, {
      testSecret: SECRET, secretMatches: async () => false, maxConcurrency: 4,
      fetch: (async (_url: string, init: { body: string }) => { controls.push(JSON.parse(init.body) as Record<string, unknown>); return new Response('{"status":"ok"}'); }) as unknown as typeof fetch,
      later: (_ms, fn) => fn(),
      clinicById: async (id) => (id === 'clinic_bakeoff_callerid' ? clinic : null),
      openCall: (_clinicId, sessionId, from, channel, startedBy, last4, how) => calls.open(clinic.id, sessionId, from, channel, startedBy, last4, how),
      recorderFor: (_clinicId, callId) => ({ appendSegment: (s) => calls.appendSegment(clinic.id, callId, s), close: (c) => calls.close(clinic.id, callId, c) }),
      actionsFor: (_clinicId, callId) => ({ record: (a) => calls.recordAction(clinic.id, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, taskRevision: a.revision, patientId: a.patientId }) }),
      backend: {
        patients: new PostgresPatientDirectory(t.db, cipher), scheduler: new BuiltinScheduler(t.db), tasks: new PostgresTaskQueue(t.db, cipher),
        audit: new PostgresAuditLog(t.db), messenger: { sendTemplate: async () => ({ status: 'sent' as const, messageId: 'sms-1' }) },
      },
      planner: { plan: async () => { throw new Error('the Vapi path never asks the planner'); } }, log,
      now: () => new Date(),
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await t.close(); });

  const post = (message: unknown) => app.inject({
    method: 'POST', url: '/webhooks/vapi/v1/events?clinic=clinic_bakeoff_callerid', headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET }, payload: JSON.stringify({ message }),
  });

  it('finds the digits said for the number they are calling from, in English and Spanish, in digits or words', () => {
    expect(wrongCallerIdDigits("Is Bella's profile under the number you're calling from ending 0 0 9 2?", '0090')).toBe('0092');
    expect(wrongCallerIdDigits('¿La ficha está con el número desde el que llama, que termina en cero cero nueve dos?', '0090')).toBe('0092');
    expect(wrongCallerIdDigits("Is your pet's profile under the number you're calling from, ending 0090?", '0090')).toBeNull();
    // another number the caller gave is theirs to say: not the caller ID
    expect(wrongCallerIdDigits('The number ends in 0101.', '0090')).toBeNull();
    expect(wrongCallerIdDigits("the number you're calling from, ending 0 0 9 2", null)).toBeNull();
    expect(callerIdCorrection('en', '0190')).toBe("Sorry, I misspoke: the number you're calling from ends in 0 1 9 0.");
    expect(callerIdCorrection('es', '0190')).toBe('Perdón, me equivoqué: el número desde el que llama termina en 0 1 9 0.');
  });

  it('gives the caller ID\'s last four with an identity answer, and corrects other digits said for it at once, once', async () => {
    const call = { id: 'vapi-callerid-1', type: 'inboundPhoneCall', customer: { number: '+17205550190' }, monitor: { controlUrl: CONTROL } };
    await post({ type: 'status-update', status: 'in-progress', call });
    const ask = { role: 'user', message: 'Hi, I need to book a checkup for my dog Bella.', secondsFromStart: 4, duration: 2000 };
    const res = await post({ type: 'tool-calls', call, artifact: { messages: [ask] }, toolCallList: [{ id: 'tc_cid_1', function: { name: 'verify_caller', arguments: { owner_name: null, pet_name: null, phone: null } } }] });
    const out = JSON.parse((res.json() as { results: { result: string }[] }).results[0]!.result) as { ok: boolean; say?: string; data: Record<string, unknown> };
    expect(out.data.caller_id_last4).toBe('0190');
    expect(out.say).toContain('ends in 0 1 9 0');

    controls.length = 0;
    const wrong = { role: 'bot', message: "Is Bella's profile under the number you're calling from, ending 0 1 9 2?", secondsFromStart: 8, duration: 3000 };
    await post({ type: 'conversation-update', call, messages: [ask, wrong] });
    const said = controls.filter((c) => c.type === 'say').map((c) => c.content);
    expect(said).toEqual(["Sorry, I misspoke: the number you're calling from ends in 0 1 9 0."]);
    // said again, the same wrong digits are not corrected twice
    controls.length = 0;
    await post({ type: 'conversation-update', call, messages: [ask, wrong, { ...wrong, secondsFromStart: 14 }] });
    expect(controls.filter((c) => c.type === 'say')).toEqual([]);
    await post({ type: 'end-of-call-report', call, endedReason: 'customer-ended-call', durationSeconds: 20 });
  });
});
