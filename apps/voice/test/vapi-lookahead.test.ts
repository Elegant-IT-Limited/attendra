import { ClinicConfig, RIVERBEND_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, seedRiverbend } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { afterEarly, registerVapi } from '../src/vapi';

// Call speed (2026-11-19): on Vapi, the caller's words come to us as a final transcript before Vapi's model runs. They go
// to the agent at once, the lookup they make plain runs, and its result is added to Vapi's conversation with no reply of
// its own, so the model can answer from it in one round. Vapi's own line for the same words is later fed only for what
// it adds. Made-up demo data only (555-01xx); nothing here reaches Vapi.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const SECRET = 'a-vapi-shared-secret-for-the-lookahead-tests-0123';
const CONTROL = 'https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-live/control';
const clinic = ClinicConfig.parse({ ...RIVERBEND_CLINIC, afterHours: 'book' });

describe('lookup-ahead on a Vapi call', () => {
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
      clinicById: async (id) => (id === 'clinic_bakeoff_lookahead' ? clinic : null),
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
    method: 'POST', url: '/webhooks/vapi/v1/events?clinic=clinic_bakeoff_lookahead', headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET }, payload: JSON.stringify({ message }),
  });

  const added = () => controls.filter((c) => c.type === 'add-message').map((c) => String((c.message as { content: string }).content));

  it('an hours question in a final transcript runs clinic_now and adds its result without a reply', async () => {
    const call = { id: 'vapi-la-1', type: 'inboundPhoneCall', customer: { number: '+17205550199' }, monitor: { controlUrl: CONTROL } };
    await post({ type: 'status-update', status: 'in-progress', call });
    controls.length = 0;
    await post({ type: 'transcript', transcriptType: 'final', role: 'user', transcript: 'Hi, are you open on Saturday?', call });
    const lookups = added().filter((c) => c.includes('A lookup for the caller\'s last words has already run'));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toContain('clinic_now returned');
    expect(controls.find((c) => c.type === 'add-message' && String((c.message as { content: string }).content).includes('clinic_now returned'))).toMatchObject({ triggerResponseEnabled: false });
    // partial transcripts and the assistant's own words run nothing
    controls.length = 0;
    await post({ type: 'transcript', transcriptType: 'partial', role: 'user', transcript: 'are you open on', call });
    await post({ type: 'transcript', transcriptType: 'final', role: 'assistant', transcript: 'Are you open on Saturday?', call });
    expect(added()).toEqual([]);
  });

  it('a yes to the caller-ID question looks up the number\'s pets at once; Vapi\'s own line for the yes is not fed again', async () => {
    const call = { id: 'vapi-la-2', type: 'inboundPhoneCall', customer: { number: '+17205550172' }, monitor: { controlUrl: CONTROL } };
    await post({ type: 'status-update', status: 'in-progress', call });
    const want = { role: 'user', message: 'Hi, I want to book a visit.', secondsFromStart: 4, duration: 1500 };
    const asked = { role: 'bot', message: "Sure. Is your pet's profile under the number you're calling from, ending zero one seven two?", secondsFromStart: 6, duration: 3000 };
    await post({ type: 'conversation-update', call, messages: [want, asked] });
    controls.length = 0;
    await post({ type: 'transcript', transcriptType: 'final', role: 'user', transcript: 'Yes.', call });
    const lookups = added().filter((c) => c.includes('verify_caller returned'));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toContain('Biscuit');
    // Vapi's model, a moment later, calls the tool for the same thing: the answer is the same, from the call's memory
    const yes = { role: 'user', message: 'Yes.', secondsFromStart: 10, duration: 500 };
    const res = await post({ type: 'tool-calls', call, artifact: { messages: [want, asked, yes] }, toolCallList: [{ id: 'tc_la_2', function: { name: 'verify_caller', arguments: { owner_name: null, pet_name: null, phone: null } } }] });
    const out = JSON.parse((res.json() as { results: { result: string }[] }).results[0]!.result) as { data: Record<string, unknown> };
    expect(JSON.stringify(out.data)).toContain('Biscuit');
  });

  it('Vapi\'s line for words already given is fed only for what it adds', () => {
    expect(afterEarly('Yes.', 'yes')).toEqual({ rest: '', early: '' });
    expect(afterEarly('Yes, for Biscuit.', 'yes')).toEqual({ rest: 'for Biscuit.', early: '' });
    // the caller spoke twice before Vapi's lines came: the first line takes its part, the rest waits for the next
    expect(afterEarly('Yes.', 'yes for biscuit')).toEqual({ rest: '', early: 'for biscuit' });
    expect(afterEarly('For Biscuit.', 'for biscuit')).toEqual({ rest: '', early: '' });
    // other words: fed whole
    expect(afterEarly('No, my wife\'s number.', 'yes')).toEqual({ rest: null, early: '' });
    expect(afterEarly('¿Sí, para Biscuit?', 'si')).toEqual({ rest: 'para Biscuit?', early: '' });
  });
});
