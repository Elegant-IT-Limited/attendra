import { ClinicConfig, PACKS, RIVERBEND_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, seedRiverbend } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveRegistry, type Numbered } from '../src/live';
import { registerVapi } from '../src/vapi';

// V1 (2026-11-18): a Vapi call in progress was missing from the dashboard's live strip, and opening it showed nothing
// until it ended: the Vapi route never opened the call in the live registry path A's calls are in, nor set the agent's
// observer. Now it does, from the call's first message. Made-up demo data only; nothing here reaches Vapi.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const SECRET = 'a-vapi-shared-secret-for-the-live-tests-0123456789';
const CONTROL = 'https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-live/control';
const clinic = ClinicConfig.parse({ ...RIVERBEND_CLINIC, afterHours: 'book' });
const FRONT_DESK = clinic.routing.find((r) => r.target === 'front_desk')!.uri;

describe('a Vapi call on the live strip', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  const live = new LiveRegistry(2000, 0);
  const controls: Record<string, unknown>[] = [];
  let failControl = false;

  beforeAll(async () => {
    t = await openTestDatabase();
    const cipher = createPhiCipher(TEST_DATA_KEY);
    await seedRiverbend(t.db, cipher);
    const calls = new CallRepository(t.db, cipher);
    registerVapi(app, {
      testSecret: SECRET, secretMatches: async () => false, maxConcurrency: 4,
      fetch: (async (_url: string, init: { body: string }) => {
        if (failControl) return new Response('{}', { status: 500 });
        controls.push(JSON.parse(init.body) as Record<string, unknown>);
        return new Response('{"status":"ok"}');
      }) as unknown as typeof fetch,
      later: (_ms, fn) => fn(),
      // the test clinics take Vapi calls with the deployment's secret: Riverbend's settings under a test clinic id
      clinicById: async (id) => (id === 'clinic_demo_live' ? { ...clinic, id } : null),
      openCall: (_clinicId, sessionId, from, channel, startedBy, last4, how) => calls.open(clinic.id, sessionId, from, channel, startedBy, last4, how),
      recorderFor: (_clinicId, callId) => ({ appendSegment: (s) => calls.appendSegment(clinic.id, callId, s), close: (c) => calls.close(clinic.id, callId, c) }),
      actionsFor: (_clinicId, callId) => ({ record: (a) => calls.recordAction(clinic.id, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, taskRevision: a.revision, patientId: a.patientId }) }),
      backend: {
        patients: new PostgresPatientDirectory(t.db, cipher), scheduler: new BuiltinScheduler(t.db), tasks: new PostgresTaskQueue(t.db, cipher),
        audit: new PostgresAuditLog(t.db), messenger: { sendTemplate: async () => ({ status: 'sent' as const, messageId: 'sms-1' }) },
      },
      planner: { plan: async () => { throw new Error('the Vapi path never asks the planner'); } }, log,
      now: () => new Date(),
      live,
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await t.close(); });

  const post = (message: unknown) => app.inject({
    method: 'POST', url: '/webhooks/vapi/v1/events?clinic=clinic_demo_live', headers: { 'content-type': 'application/json', 'x-vapi-secret': SECRET }, payload: JSON.stringify({ message }),
  });
  const watch = (callId: string) => {
    const seen: Numbered[] = [];
    live.subscribe('clinic_demo_live', callId, null, (e) => seen.push(e));
    return seen;
  };

  it('shows the call from its first message, with its captions, tool steps and state, and takes it off when it ends', async () => {
    const call = { id: 'vapi-live-1', type: 'inboundPhoneCall', customer: { number: '+17205550172' }, monitor: { controlUrl: CONTROL } };
    await post({ type: 'status-update', status: 'in-progress', call });
    const [shown] = live.list('clinic_demo_live');
    expect(shown).toMatchObject({ channel: 'phone', emergency: false });
    const seen = watch(shown!.callId);
    expect(seen[0]!.event.type).toBe('snapshot');

    const greeting = { role: 'bot', message: clinic.greeting, secondsFromStart: 0.5, duration: 3000 };
    const ask = { role: 'user', message: 'Hi, what time do you close today?', secondsFromStart: 4, duration: 1800 };
    await post({ type: 'conversation-update', call, messages: [greeting, ask] });
    await post({ type: 'tool-calls', call, toolCallList: [{ id: 'tc_live_1', function: { name: 'get_clinic_info', arguments: { topic: 'hours' } } }], artifact: { messages: [greeting, ask] } });
    const answer = { role: 'bot', message: 'We close at six today.', secondsFromStart: 8, duration: 1500 };
    await post({ type: 'conversation-update', call, messages: [greeting, ask, answer] });

    const captions = seen.flatMap((n) => (n.event.type === 'caption' ? [`${n.event.speaker}: ${n.event.text}`] : []));
    expect(captions).toEqual([`agent: ${clinic.greeting}`, 'caller: Hi, what time do you close today?', 'agent: We close at six today.']);
    expect(seen.some((n) => n.event.type === 'tool' && n.event.tool === 'get_clinic_info' && n.event.status === 'started')).toBe(true);
    expect(seen.some((n) => n.event.type === 'state')).toBe(true);

    await post({ type: 'end-of-call-report', call, endedReason: 'customer-ended-call', durationSeconds: 12, artifact: { messages: [greeting, ask, answer] } });
    expect(live.list('clinic_demo_live')).toEqual([]);
    expect(seen.at(-1)!.event).toMatchObject({ type: 'ended' });
  });

  it('marks an emergency on the strip as path A does', async () => {
    const call = { id: 'vapi-live-2', type: 'inboundPhoneCall', customer: { number: '+17205550173' }, monitor: { controlUrl: CONTROL } };
    await post({ type: 'conversation-update', call, messages: [{ role: 'user', message: "My dog Biscuit's throat is swelling up!", secondsFromStart: 4, duration: 2000 }] });
    expect(live.list('clinic_demo_live')[0]?.emergency).toBe(true);
    await post({ type: 'status-update', status: 'ended', call });
    // off the strip once Vapi says the call ended, even before its report
    expect(live.list('clinic_demo_live')).toEqual([]);
    await post({ type: 'end-of-call-report', call, endedReason: 'customer-ended-call', durationSeconds: 8 });
  });

  it('a staff note reaches the model as a system message, never said aloud, and shows as delivered', async () => {
    controls.length = 0;
    const call = { id: 'vapi-live-3', type: 'inboundPhoneCall', customer: { number: '+17205550174' }, monitor: { controlUrl: CONTROL } };
    await post({ type: 'status-update', status: 'in-progress', call });
    const callId = live.list('clinic_demo_live')[0]!.callId;
    const seen = watch(callId);
    controls.length = 0;
    expect(await live.coach('clinic_demo_live', callId, 'k1', 'Offer the Thursday 3 pm slot first.', 'A. Staff')).toEqual({ ok: true, repeat: false });
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ type: 'add-message', message: { role: 'system' }, triggerResponseEnabled: false });
    expect(JSON.stringify(controls[0])).toContain('Offer the Thursday 3 pm slot first.');
    expect(controls.some((c) => c.type === 'say')).toBe(false);
    expect(seen.some((n) => n.event.type === 'staff' && n.event.action === 'coach_delivered')).toBe(true);
    // a note that could not be sent is not a repeat when sent again
    failControl = true;
    try { await expect(live.coach('clinic_demo_live', callId, 'k2', 'Another note.', null)).rejects.toThrow(); } finally { failControl = false; }
    expect(await live.coach('clinic_demo_live', callId, 'k2', 'Another note.', null)).toEqual({ ok: true, repeat: false });
    await post({ type: 'end-of-call-report', call, endedReason: 'customer-ended-call', durationSeconds: 8 });
  });

  it('"Take the call" says the take-over line and puts the caller through to the front desk, through the control URL', async () => {
    const call = { id: 'vapi-live-4', type: 'inboundPhoneCall', customer: { number: '+17205550175' }, monitor: { controlUrl: CONTROL } };
    await post({ type: 'status-update', status: 'in-progress', call });
    const callId = live.list('clinic_demo_live')[0]!.callId;
    expect(live.frontDeskOf('clinic_demo_live', callId)).toBe(FRONT_DESK);
    expect(live.frontDeskOf('clinic_other', callId)).toBeNull();
    controls.length = 0;
    expect(await live.claim('clinic_demo_live', callId, 'take-1', 'user_1', 'take_over', (c) => c.takeOver(FRONT_DESK, 'A. Staff'))).toEqual({ ok: true, repeat: false });
    expect(controls.find((c) => c.type === 'say')?.content).toBe(PACKS.en.takeOver);
    expect(controls.find((c) => c.type === 'transfer')).toMatchObject({ destination: { type: 'number', number: FRONT_DESK.slice(4) } });
    await post({ type: 'end-of-call-report', call, endedReason: 'assistant-forwarded-call', durationSeconds: 9 });
  });

  it('a take-over that does not go through gives the call back to staff, and "End" says goodbye and ends the call', async () => {
    const call = { id: 'vapi-live-5', type: 'inboundPhoneCall', customer: { number: '+17205550176' }, monitor: { controlUrl: CONTROL } };
    await post({ type: 'status-update', status: 'in-progress', call });
    const callId = live.list('clinic_demo_live')[0]!.callId;
    const seen = watch(callId);
    failControl = true;
    try { await live.claim('clinic_demo_live', callId, 'take-2', 'user_1', 'take_over', (c) => c.takeOver(FRONT_DESK, null)); } finally { failControl = false; }
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.some((n) => n.event.type === 'staff' && n.event.action === 'transfer_failed')).toBe(true);
    controls.length = 0;
    // the claim was given back: someone may end the call now
    expect(await live.claim('clinic_demo_live', callId, 'end-1', 'user_2', 'end', (c) => c.end(null))).toEqual({ ok: true, repeat: false });
    expect(controls.map((c) => c.type)).toContain('end-call');
    await post({ type: 'end-of-call-report', call, endedReason: 'assistant-ended-call', durationSeconds: 9 });
  });
});
