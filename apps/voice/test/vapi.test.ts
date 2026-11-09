import { ClinicConfig, DEMO_CLINIC, RIVERBEND_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, saveVapiSecret, seedDemo, seedRiverbend, vapiCallEnded, vapiCallLive, vapiConcurrency, vapiSecretHashOf, vapiSecretMatches } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quotedLines, registerVapi, vapiControlUrl, vapiDestination } from '../src/vapi';

// Vapi as a location's backup engine (batch 6; path C of the bake-off before it): a Vapi assistant whose tools are ours.
// Same agent, same rules, its own engine on the call row. Made-up demo data only; nothing here reaches Vapi.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const TEST_SECRET = 'a-vapi-shared-secret-for-the-tests-only-0123456789';
const LOCATION_SECRET = 'oak-hill-location-secret-for-the-tests-0123456789';
const clinic = ClinicConfig.parse({ ...RIVERBEND_CLINIC, afterHours: 'book' });
// a real location (not a test clinic): the demo medical clinic's settings under another id, switched to Vapi
const OAK = 'clinic_oak_vapi';
const CONTROL = 'https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-x/control';

describe('Vapi calling our tools', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  let oak: ClinicConfig = ClinicConfig.parse({ ...DEMO_CLINIC, id: OAK, voiceEngine: 'vapi' });
  const controls: { url: string; body: Record<string, unknown> }[] = [];
  const redirectModes: (string | undefined)[] = [];
  const alerts: string[] = [];
  const allAlerts: string[] = [];

  beforeAll(async () => {
    t = await openTestDatabase();
    const cipher = createPhiCipher(TEST_DATA_KEY);
    await seedRiverbend(t.db, cipher);
    await seedDemo(t.db, cipher);
    // the location's own row, so its secret and calls have a clinic to belong to
    await t.owner.execute(`insert into clinics (id, org_id, name, timezone, config) select '${OAK}', org_id, name, timezone, config from clinics where id = '${DEMO_CLINIC.id}'`);
    await saveVapiSecret(t.db, cipher, OAK, LOCATION_SECRET);
    const calls = new CallRepository(t.db, cipher);
    registerVapi(app, {
      testSecret: TEST_SECRET,
      secretMatches: async (id, presented) => vapiSecretMatches(cipher, id, presented, await vapiSecretHashOf(t.db, id)),
      calls: { live: (id, at, alertAt) => vapiCallLive(t.db, id, at, alertAt), ended: (id, at) => vapiCallEnded(t.db, id, at) },
      maxConcurrency: 4,
      fetch: (async (url: string, init: { body: string; redirect?: string }) => {
        redirectModes.push(init.redirect);
        // a control address that redirects: fetch with redirect 'error' throws, as Node's does
        if (url.includes('/redirect-me/')) throw new TypeError('fetch failed: unexpected redirect');
        controls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return new Response('{"status":"ok"}');
      }) as unknown as typeof fetch,
      later: (_ms, fn) => fn(),
      clinicById: async (id) => (id === clinic.id ? clinic : id === OAK ? oak : null),
      openCall: (clinicId, sessionId, from, channel, startedBy, last4, how) => calls.open(clinicId, sessionId, from, channel, startedBy, last4, how),
      recorderFor: (clinicId, callId) => ({ appendSegment: (s) => calls.appendSegment(clinicId, callId, s), close: (c) => calls.close(clinicId, callId, c) }),
      actionsFor: (clinicId, callId) => ({ record: (a) => calls.recordAction(clinicId, callId, { tool: a.tool, argsRedacted: a.argsRedacted, result: a.result, taskRevision: a.revision, patientId: a.patientId }) }),
      backend: {
        patients: new PostgresPatientDirectory(t.db, cipher), scheduler: new BuiltinScheduler(t.db), tasks: new PostgresTaskQueue(t.db, cipher),
        audit: new PostgresAuditLog(t.db), messenger: { sendTemplate: async () => ({ status: 'sent' as const, messageId: 'sms-1' }) },
      },
      planner: { plan: async () => { throw new Error('the Vapi path never asks the planner'); } }, log,
      alerts: { alert: (_k, text) => { alerts.push(text); allAlerts.push(text); }, note: () => {}, flush: async () => {} },
      now: () => new Date(),
    });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await t.close(); });

  const post = (message: unknown, secret: string | null = TEST_SECRET, clinicId = clinic.id) => app.inject({
    method: 'POST', url: `/webhooks/vapi/v1/events?clinic=${clinicId}`, headers: { 'content-type': 'application/json', ...(secret ? { 'x-vapi-secret': secret } : {}) }, payload: JSON.stringify({ message }),
  });
  const resultOf = (res: Awaited<ReturnType<typeof post>>) => JSON.parse((res.json() as { results: { result: string }[] }).results[0]!.result) as { ok: boolean; outcome: string; say?: string };
  const call = { id: 'vapi-call-1', type: 'webCall' };

  it('refuses a request without the secret', async () => {
    expect((await post({ type: 'tool-calls', call, toolCallList: [] }, null)).statusCode).toBe(401);
    expect((await post({ type: 'tool-calls', call, toolCallList: [] }, 'wrong-secret')).statusCode).toBe(401);
    // no clinic, or a malformed one: refused the same way, before the body is read
    expect((await app.inject({ method: 'POST', url: '/webhooks/vapi/v1/events', headers: { 'content-type': 'application/json', 'x-vapi-secret': TEST_SECRET }, payload: '{}' })).statusCode).toBe(401);
  });

  it('takes a location\'s own secret for that location only, and the deployment\'s secret for the test clinics only', async () => {
    const msg = { type: 'conversation-update', call: { id: 'vapi-auth' }, messages: [] };
    expect((await post(msg, LOCATION_SECRET, OAK)).statusCode).toBe(200);
    // the deployment-wide secret never opens a real location
    expect((await post(msg, TEST_SECRET, OAK)).statusCode).toBe(401);
    // nor does a location's secret open another clinic
    expect((await post(msg, LOCATION_SECRET, clinic.id)).statusCode).toBe(401);
    expect((await post(msg, LOCATION_SECRET, DEMO_CLINIC.id)).statusCode).toBe(401);
  });

  it('answers Vapi\'s tool calls with our tools, keeps its conversation, and records the call as engine vapi', async () => {
    const res = await post({ type: 'tool-calls', call, toolCallList: [{ id: 'tc_1', function: { name: 'clinic_now', arguments: {} } }] });
    expect(res.statusCode).toBe(200);
    const [r] = (res.json() as { results: { toolCallId: string; result: string }[] }).results;
    expect(r!.toolCallId).toBe('tc_1');
    expect(JSON.parse(r!.result)).toMatchObject({ ok: true, outcome: 'ok', data: { zone: clinic.timezone } });

    // the number read back, and a yes split from a "hello?", from Vapi's own conversation, in Vapi's units
    // (secondsFromStart in seconds, duration in ms, a system line and tool entries in between, as a real call sends)
    const greeting = { role: 'bot', message: clinic.greeting, secondsFromStart: 1.12, duration: 3360 };
    const number = { role: 'user', message: 'I need a checkup for my dog. The number is 720 555 0172.', secondsFromStart: 5.2, duration: 3920.0009765625 };
    await post({ type: 'conversation-update', call, messages: [{ role: 'system', message: 'prompt', secondsFromStart: 0 }, greeting, number] });
    const asked = await post({ type: 'tool-calls', call, toolCallList: [{ id: 'tc_2', function: { name: 'verify_caller', arguments: JSON.stringify({ owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' }) } }] });
    expect(resultOf(asked)).toMatchObject({ outcome: 'confirm_number' });
    await post({ type: 'conversation-update', call, messages: [
      { role: 'system', message: 'prompt', secondsFromStart: 0 }, greeting, number,
      { role: 'tool_calls', secondsFromStart: 9.4 }, { role: 'tool_call_result', secondsFromStart: 9.8 },
      { role: 'bot', message: "That's 720-555-0172?", secondsFromStart: 10.3, duration: 2560 },
      { role: 'user', message: 'Yes. Hello?', secondsFromStart: 14.1, duration: 959.9990234375 },
    ] });
    const named = await post({ type: 'tool-calls', call, toolCallList: [{ id: 'tc_3', function: { name: 'verify_caller', arguments: { owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' } } }] });
    expect(resultOf(named).outcome).toBe('owner_check');

    await post({ type: 'end-of-call-report', call, endedReason: 'customer-ended-call', durationSeconds: 42, cost: 0.0912 });
    await t.client.query(`select set_config('app.clinic_id', $1, false)`, [clinic.id]);
    const rows = (await t.client.query(`select c.engine, c.voice_flow, c.channel, c.voice_seconds, (select count(*)::int from call_segments s where s.call_id = c.id) as lines, (select engine from call_costs k where k.call_id = c.id) as cost_engine, (select voice_usd from call_costs k where k.call_id = c.id) as voice_usd from calls c where c.openai_session_id = 'vapi_vapi-call-1'`)).rows;
    expect(rows).toEqual([{ engine: 'vapi', voice_flow: 'tools', channel: 'web', voice_seconds: '42.00', lines: 4, cost_engine: 'vapi', voice_usd: '0.091200' }]);
  });

  it('records each line once from both of Vapi\'s list shapes, with the first audio and the wait for a tool answer', async () => {
    const c = { id: 'vapi-call-3', type: 'webCall' };
    const greeting = { role: 'bot', message: clinic.greeting, secondsFromStart: 1.12, duration: 3360 };
    const ask = { role: 'user', message: 'What time do you close today?', secondsFromStart: 5.2, duration: 1800 };
    const toolCall = { role: 'tool_calls', secondsFromStart: 7.4 };
    const toolResult = { role: 'tool_call_result', secondsFromStart: 7.5 };
    const answer = { role: 'bot', message: 'We close at six today.', secondsFromStart: 8.9, duration: 1500 };
    await post({ type: 'tool-calls', call: c, artifact: { messages: [{ role: 'system', message: 'prompt', secondsFromStart: 0 }, greeting, ask, toolCall] }, toolCallList: [{ id: 'tc_a', function: { name: 'clinic_now', arguments: {} } }] });
    await post({ type: 'conversation-update', call: c, messages: [greeting, ask] });
    await post({ type: 'conversation-update', call: c, messages: [{ ...greeting, message: 'Thanks for calling', secondsFromStart: 1.9, duration: 1200 }, { ...ask, duration: 2400 }, answer] });
    await post({ type: 'conversation-update', call: c, messages: [{ role: 'system', message: 'prompt', secondsFromStart: 0 }, greeting, ask, toolCall, toolResult, answer] });
    await post({ type: 'end-of-call-report', call: c, endedReason: 'customer-ended-call', durationSeconds: 12, cost: 0.02, artifact: { messages: [{ role: 'system', message: 'prompt', secondsFromStart: 0 }, greeting, ask, toolCall, toolResult, answer] } });
    await t.client.query(`select set_config('app.clinic_id', $1, false)`, [clinic.id]);
    const [row] = (await t.client.query(`select c.first_audio_ms, (select count(*)::int from call_segments s where s.call_id = c.id) as lines,
      (select result->>'wait_ms' from call_actions a where a.call_id = c.id and a.tool = 'answer_timing') as wait from calls c where c.openai_session_id = 'vapi_vapi-call-3'`)).rows;
    expect(row).toEqual({ first_audio_ms: 1120, lines: 3, wait: '1900' });
  });

  it('refuses a clinic it does not know, as a result Vapi can say', async () => {
    const res = await post({ type: 'tool-calls', call: { id: 'vapi-call-2', type: 'webCall' }, toolCallList: [{ id: 'tc_9', function: { name: 'clinic_now', arguments: {} } }] }, TEST_SECRET, 'clinic_demo_unknown');
    expect(res.json()).toEqual({ results: [{ toolCallId: 'tc_9', error: 'This call cannot be helped here.' }] });
  });

  it('takes a new call only for a location on Vapi, and lets a call already going finish after it is switched back', async () => {
    const going = { id: 'vapi-oak-going', type: 'inboundPhoneCall', customer: { number: '+13035550147' }, monitor: { controlUrl: CONTROL } };
    expect(resultOf(await post({ type: 'tool-calls', call: going, toolCallList: [{ id: 'g1', function: { name: 'clinic_now', arguments: {} } }] }, LOCATION_SECRET, OAK)).ok).toBe(true);
    // switched back to our own engine: the call in progress carries on, a new one is refused (and said in Slack)
    oak = { ...oak, voiceEngine: 'gpt-realtime' };
    try {
      expect(resultOf(await post({ type: 'tool-calls', call: going, toolCallList: [{ id: 'g2', function: { name: 'clinic_now', arguments: {} } }] }, LOCATION_SECRET, OAK)).ok).toBe(true);
      const fresh = await post({ type: 'tool-calls', call: { id: 'vapi-oak-new', type: 'inboundPhoneCall' }, toolCallList: [{ id: 'n1', function: { name: 'clinic_now', arguments: {} } }] }, LOCATION_SECRET, OAK);
      expect(fresh.json()).toEqual({ results: [{ toolCallId: 'n1', error: 'This call cannot be helped here.' }] });
      expect(alerts.some((a) => a.includes(`new call for ${OAK}`))).toBe(true);
    } finally { oak = { ...oak, voiceEngine: 'vapi' }; }
    await post({ type: 'end-of-call-report', call: going, endedReason: 'customer-ended-call', durationSeconds: 20 }, LOCATION_SECRET, OAK);
  });

  it('says the emergency script on the call at once and puts the caller through, through the call\'s control URL', async () => {
    controls.length = 0;
    const c = { id: 'vapi-oak-emergency', type: 'inboundPhoneCall', customer: { number: '+13035550163' }, monitor: { controlUrl: CONTROL } };
    await post({ type: 'tool-calls', call: c, toolCallList: [{ id: 'e1', function: { name: 'clinic_now', arguments: {} } }] }, LOCATION_SECRET, OAK);
    await post({ type: 'conversation-update', call: c, messages: [
      { role: 'bot', message: oak.greeting, secondsFromStart: 0.5, duration: 3000 },
      { role: 'user', message: "I've got chest pain right now and my left arm is numb.", secondsFromStart: 5, duration: 2500 },
    ] }, LOCATION_SECRET, OAK);
    const said = controls.find((x) => x.body.type === 'say');
    expect(said?.url).toBe(CONTROL);
    expect(said?.body).toMatchObject({ interruptAssistantEnabled: true });
    expect(String(said?.body.content)).toContain('911');
    expect(controls.some((x) => x.body.type === 'add-message' && (x.body.message as { role: string }).role === 'system')).toBe(true);
    // the on-call line, as on our own engines (DEMO_CLINIC's emergency route)
    expect(controls.find((x) => x.body.type === 'transfer')?.body.destination).toEqual({ type: 'number', number: '+13035550199' });
    await post({ type: 'end-of-call-report', call: c, endedReason: 'assistant-forwarded-call', durationSeconds: 30, cost: 0.05 }, LOCATION_SECRET, OAK);
    await t.client.query(`select set_config('app.clinic_id', $1, false)`, [OAK]);
    const [row] = (await t.client.query(`select outcome, emergency_flag, engine from calls where openai_session_id = 'vapi_vapi-oak-emergency'`)).rows;
    expect(row).toEqual({ outcome: 'emergency', emergency_flag: true, engine: 'vapi' });
  });

  it('counts the Vapi calls live at once, keeps the day\'s peak and says it once at 70% of the limit', async () => {
    const ids = ['live-1', 'live-2', 'live-3', 'live-4'];
    for (const id of ids) await post({ type: 'status-update', status: 'in-progress', call: { id } }, LOCATION_SECRET, OAK);
    const now = await vapiConcurrency(t.db, new Date());
    expect(now.live).toBeGreaterThanOrEqual(4);
    expect(now.todayPeak).toBeGreaterThanOrEqual(4);
    // 3 of 4 is the alert: once a day (UTC), however many more come, whichever call of this file reached it first
    expect(now.alertedAt).not.toBeNull();
    expect(allAlerts.filter((a) => a.startsWith('Vapi calls at the same moment')).length).toBe(1);
    for (const id of ids) await post({ type: 'status-update', status: 'ended', call: { id } }, LOCATION_SECRET, OAK);
    const after = await vapiConcurrency(t.db, new Date());
    expect(after.live).toBe(now.live - 4);
    expect(after.todayPeak).toBe(now.todayPeak);
  });

  it('reads a transfer target and a script the way Vapi\'s control URL takes them', () => {
    expect(vapiDestination('tel:+13035550199')).toEqual({ type: 'number', number: '+13035550199' });
    expect(vapiDestination('sip:frontdesk@pbx.example.com')).toEqual({ type: 'sip', sipUri: 'sip:frontdesk@pbx.example.com' });
    expect(vapiDestination('mailto:x')).toBeNull();
    expect(quotedLines('Say: "Call 911 now." Then "Stay on the line."')).toBe('Call 911 now. Stay on the line.');
    expect(quotedLines('The caller used insulting language.')).toBe('');
  });

  it('follows no redirect from a control address: a redirect is a failure, said to the team, never thrown into the call', async () => {
    controls.length = 0; redirectModes.length = 0; alerts.length = 0;
    const c = { id: 'vapi-oak-redirect', type: 'inboundPhoneCall', monitor: { controlUrl: 'https://phone-call-websocket.vapi.ai/redirect-me/control' } };
    await post({ type: 'tool-calls', call: c, toolCallList: [{ id: 'r1', function: { name: 'clinic_now', arguments: {} } }] }, LOCATION_SECRET, OAK);
    await post({ type: 'conversation-update', call: c, messages: [{ role: 'user', message: "I've got chest pain right now and my left arm is numb.", secondsFromStart: 5, duration: 2500 }] }, LOCATION_SECRET, OAK);
    expect(redirectModes.length).toBeGreaterThan(0);
    expect(new Set(redirectModes)).toEqual(new Set(['error']));
    expect(controls).toEqual([]);
    expect(alerts.some((a) => a.includes('could not be'))).toBe(true);
    await post({ type: 'end-of-call-report', call: c, endedReason: 'customer-ended-call', durationSeconds: 5 }, LOCATION_SECRET, OAK);
  });

  it('never sends a control command to a host that is not Vapi\'s', async () => {
    controls.length = 0;
    const c = { id: 'vapi-oak-evil', type: 'inboundPhoneCall', monitor: { controlUrl: 'https://evil.example.com/control' } };
    await post({ type: 'tool-calls', call: c, toolCallList: [{ id: 'v1', function: { name: 'clinic_now', arguments: {} } }] }, LOCATION_SECRET, OAK);
    await post({ type: 'conversation-update', call: c, messages: [{ role: 'user', message: "I've got chest pain right now and my left arm is numb.", secondsFromStart: 5, duration: 2500 }] }, LOCATION_SECRET, OAK);
    expect(controls).toEqual([]);
    // without a control URL, the script goes with the next tool result, as before
    const next = resultOf(await post({ type: 'tool-calls', call: c, toolCallList: [{ id: 'v2', function: { name: 'clinic_now', arguments: {} } }] }, LOCATION_SECRET, OAK));
    expect(next.say ?? '').toContain('911');
    await post({ type: 'end-of-call-report', call: c, endedReason: 'customer-ended-call', durationSeconds: 5 }, LOCATION_SECRET, OAK);
  });
});

/** A Vapi address carrying a user name (and password): built with URL, so the source holds no address-like text. */
function withCredentials(user: string, password: string): string {
  const u = new URL('https://phone.vapi.ai/call-x/control');
  u.username = user;
  u.password = password;
  return u.toString();
}

describe('the control address a Vapi message may carry (CodeQL #20: checked, then trusted)', () => {
  it('takes only https on vapi.ai or a subdomain, with no credentials and the default port', () => {
    expect(vapiControlUrl('https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-x/control')).toBe('https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-x/control');
    expect(vapiControlUrl('https://vapi.ai/call-x/control')).toBe('https://vapi.ai/call-x/control');
    expect(vapiControlUrl('https://PHONE.Vapi.AI:443/call-x/control')).toBe('https://phone.vapi.ai/call-x/control');
    for (const bad of [
      'https://evilvapi.ai/call-x/control',
      'https://vapi.ai.evil.com/call-x/control',
      'http://phone.vapi.ai/call-x/control',
      withCredentials('user', 'pass'),
      withCredentials('user', ''),
      'https://phone.vapi.ai:8443/call-x/control',
      'https://phone.vapi.ai.:444/x',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) expect(vapiControlUrl(bad), bad).toBeNull();
    expect(vapiControlUrl(undefined)).toBeNull();
    expect(vapiControlUrl(42)).toBeNull();
  });
});
