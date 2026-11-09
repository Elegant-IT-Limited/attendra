import { DEMO_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, vapiCallLive, vapiSecretHashOf, vapiSecretMatches, vapiSecretOf } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { type VapiClient, VapiError } from '@attendra/voice-engine';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// A location's Vapi resources by provisioning (batch 6). Vapi is a stand-in that records what it was sent: nothing here
// reaches Vapi. Made-up demo data only.
const TOKEN = 'p'.repeat(40);
const auth = `Bearer ${TOKEN}`;
const P = '/api/v1/provisioning';
const C = DEMO_CLINIC.id;
const NUMBER = '+13035550188';

type Sent = { op: string; id?: string; body?: unknown };
function fakeVapi() {
  const sent: Sent[] = [];
  let n = 0;
  const gone = new Set<string>();
  const client: VapiClient = {
    createAssistant: async (body) => { sent.push({ op: 'createAssistant', body }); return { id: `asst_${++n}` }; },
    updateAssistant: async (id, body) => { sent.push({ op: 'updateAssistant', id, body }); if (gone.has(id)) throw new VapiError(404, 'not found', 'PATCH /assistant'); return { id }; },
    createPhoneNumber: async (body) => { sent.push({ op: 'createPhoneNumber', body }); return { id: `pn_${++n}` }; },
    updatePhoneNumber: async (id, body) => { sent.push({ op: 'updatePhoneNumber', id, body }); return { id }; },
    deletePhoneNumber: async (id) => { sent.push({ op: 'deletePhoneNumber', id }); },
    createCredential: async () => { throw new Error('never from a route'); },
    updateCredential: async () => { throw new Error('never from a route'); },
  };
  return { client, sent, gone };
}

describe('Vapi per location (provisioning)', () => {
  const vapi = fakeVapi();
  const alerts: string[] = [];
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeAll(async () => {
    api = await startApi({
      demoMode: false, twoFactor: 'optional', provisioningToken: TOKEN,
      vapi: { client: vapi.client, credentialId: 'cred_twilio_vapi', sipHost: 'sip.vapi.ai', serverBase: 'https://app.example.com', maxConcurrency: 4, syncDelayMs: 0 },
      alerts: { alert: (_k, t) => { alerts.push(t); }, note: () => {}, flush: async () => {} },
    });
    expect((await api.request('PUT', `${P}/clinics/${C}/numbers/${encodeURIComponent(NUMBER)}`, { authorization: auth })).statusCode).toBe(204);
  });
  afterAll(() => api.close());
  let cookieOnce: Promise<string> | null = null;
  const adminCookie = () => (cookieOnce ??= api.signIn('olga@maple.example', true));
  const vapiState = async () => (await api.t.owner.execute(sql`select config->'vapi' as vapi, config->>'voiceEngine' as engine from clinics where id = ${C}`)).rows[0] as { vapi: Record<string, unknown> | null; engine: string | null };

  it('needs the token, and checks it before the body', async () => {
    for (const [method, path, body] of [['PUT', `${P}/clinics/${C}/vapi`, { voice: { provider: 'nope' } }], ['GET', `${P}/clinics/${C}/vapi`, undefined], ['DELETE', `${P}/clinics/${C}/vapi`, undefined], ['GET', `${P}/vapi/concurrency`, undefined], ['GET', `${P}/clinics/${C}/costs?from=x`, undefined]] as const) {
      expect((await api.request(method, path, { body })).statusCode, `${method} ${path}`).toBe(401);
    }
    expect((await api.request('PUT', `${P}/clinics/${C}/vapi`, { body: { voice: { provider: 'nope' } }, authorization: auth })).statusCode).toBe(422);
    expect((await api.request('PUT', `${P}/clinics/${C}/vapi`, { body: { secret: 'mine' }, authorization: auth })).statusCode).toBe(422);
    expect((await api.request('GET', `${P}/clinics/${C}/costs?from=yesterday`, { authorization: auth })).statusCode).toBe(422);
  });

  it('refuses to switch a location to Vapi before its assistant and number exist', async () => {
    const res = await api.request('PUT', `${P}/clinics/${C}/voice-engine`, { body: { engine: 'vapi' }, authorization: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'vapi_not_provisioned' });
  });

  it('creates the assistant from the settings and the number on the trunk, keeping ids only and the secret apart', async () => {
    const res = await api.request('PUT', `${P}/clinics/${C}/vapi`, { body: {}, authorization: auth });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out).toEqual({ assistantId: 'asst_1', phoneNumberId: 'pn_2', sipUri: `sip:${NUMBER}@cred_twilio_vapi.sip.vapi.ai`, updatedAt: expect.any(String) });
    const assistant = vapi.sent.find((s) => s.op === 'createAssistant')!.body as { firstMessage: string; server: { url: string; headers: Record<string, string> }; model: { messages: { content: string }[]; tools: { function: { name: string }; server: { url: string; headers: Record<string, string> } }[] }; voice: unknown; serverMessages: string[] };
    // the clinic's greeting, the tools voice prompt, our tools at our route for this location, with its own secret
    expect(assistant.firstMessage).toBe(DEMO_CLINIC.greeting);
    expect(assistant.server.url).toBe(`https://app.example.com/webhooks/vapi/v1/events?clinic=${C}`);
    expect(assistant.model.tools.map((t) => t.function.name)).toContain('verify_caller');
    expect(assistant.model.tools.every((t) => t.server.url === assistant.server.url)).toBe(true);
    const secret = assistant.server.headers['x-vapi-secret']!;
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(assistant.model.tools.every((t) => t.server.headers['x-vapi-secret'] === secret)).toBe(true);
    expect(assistant.voice).toEqual({ provider: 'vapi', voiceId: 'Elliot' });
    expect(assistant.serverMessages).toEqual(['conversation-update', 'end-of-call-report', 'status-update']);
    expect(vapi.sent.find((s) => s.op === 'createPhoneNumber')!.body).toEqual({ provider: 'byo-phone-number', credentialId: 'cred_twilio_vapi', number: NUMBER, numberE164CheckEnabled: true, assistantId: 'asst_1', name: `Attendra ${C}` });
    // kept: ids in the settings; the secret encrypted with its keyed hash, never in the settings or the answer
    const state = await vapiState();
    expect(state.vapi).toMatchObject({ assistantId: 'asst_1', phoneNumberId: 'pn_2', sipUri: out.sipUri, syncedHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(state.vapi)).not.toContain(secret);
    expect(JSON.stringify(out)).not.toContain(secret);
    const cipher = createPhiCipher(TEST_DATA_KEY);
    expect(await vapiSecretOf(api.t.db, cipher, C)).toBe(secret);
    const [row] = (await api.t.owner.execute(sql`select secret_enc from vapi_secrets where clinic_id = ${C}`)).rows as [{ secret_enc: string }];
    expect(row.secret_enc).not.toContain(secret);
    expect(vapiSecretMatches(cipher, C, secret, await vapiSecretHashOf(api.t.db, C))).toBe(true);
    // audited like the other provisioning switches
    const audit = (await api.t.owner.execute(sql`select action from audit_logs where clinic_id = ${C} and action like 'clinic.vapi.%'`)).rows.map((r: unknown) => (r as { action: string }).action);
    expect(audit).toContain('clinic.vapi.provisioned');
  });

  it('sending it again updates the same assistant and number, with the same secret (the manual resync)', async () => {
    vapi.sent.length = 0;
    const res = await api.request('PUT', `${P}/clinics/${C}/vapi`, { body: { voice: { provider: '11labs', voiceId: 'sarah' } }, authorization: auth });
    expect(res.json()).toMatchObject({ assistantId: 'asst_1', phoneNumberId: 'pn_2' });
    expect(vapi.sent.map((s) => s.op)).toEqual(['updateAssistant', 'updatePhoneNumber']);
    const body = vapi.sent[0]!.body as { voice: unknown; server: { headers: Record<string, string> } };
    expect(body.voice).toEqual({ provider: '11labs', voiceId: 'sarah', model: 'eleven_flash_v2_5' });
    expect(await vapiSecretOf(api.t.db, createPhiCipher(TEST_DATA_KEY), C)).toBe(body.server.headers['x-vapi-secret']);
    expect((await api.request('GET', `${P}/clinics/${C}/vapi`, { authorization: auth })).json()).toMatchObject({ onVapi: false, assistantId: 'asst_1', inSync: true, voice: { provider: '11labs', voiceId: 'sarah' } });
  });

  it('switches the location to Vapi and back, answering with the engine it replaced, audited', async () => {
    await api.request('PUT', `${P}/clinics/${C}/voice-engine`, { body: { engine: 'gpt-realtime' }, authorization: auth });
    const on = await api.request('PUT', `${P}/clinics/${C}/voice-engine`, { body: { engine: 'vapi' }, authorization: auth });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ previous: 'gpt-realtime' });
    expect(await vapiState()).toMatchObject({ engine: 'vapi', vapi: { overflowEngine: 'gpt-realtime' } });
    // the number resource stays while calls go to Vapi
    expect((await api.request('DELETE', `${P}/clinics/${C}/vapi`, { authorization: auth })).statusCode).toBe(409);
    // a save from Settings keeps the Vapi ids and the engine, whatever it sends
    const cookie = await adminCookie();
    const S = `/api/v1/clinics/${C}/settings`;
    const settings = (await api.request('GET', S, { cookie })).json();
    const saved = (await api.request('PUT', S, { cookie, body: { ...settings, voiceEngine: 'gpt-live', vapi: { assistantId: 'evil' } } })).json();
    expect(saved).toMatchObject({ voiceEngine: 'vapi', vapi: { assistantId: 'asst_1' } });
    const back = await api.request('PUT', `${P}/clinics/${C}/voice-engine`, { body: { engine: 'gpt-realtime' }, authorization: auth });
    expect(back.json()).toEqual({ previous: 'vapi' });
    const actions = (await api.t.owner.execute(sql`select action from audit_logs where clinic_id = ${C} and action like 'clinic.voice_engine.%' order by id`)).rows.map((r: unknown) => (r as { action: string }).action);
    expect(actions.slice(-3)).toEqual(['clinic.voice_engine.gpt-realtime', 'clinic.voice_engine.vapi', 'clinic.voice_engine.gpt-realtime']);
  });

  it('updates the assistant on its own when a setting it is built from changes, and not otherwise', async () => {
    const vapiOn = await api.request('PUT', `${P}/clinics/${C}/voice-engine`, { body: { engine: 'vapi' }, authorization: auth });
    expect(vapiOn.statusCode).toBe(200);
    vapi.sent.length = 0;
    const cookie = await adminCookie();
    const S = `/api/v1/clinics/${C}/settings`;
    const settings = (await api.request('GET', S, { cookie })).json();
    const greeting = 'Thanks for calling Maple Street Family Medicine, this is the AI assistant. How can I help today?';
    expect((await api.request('PUT', S, { cookie, body: { ...settings, greeting } })).statusCode).toBe(200);
    await api.vapiIdle();
    const updates = vapi.sent.filter((s) => s.op === 'updateAssistant');
    expect(updates).toHaveLength(1);
    expect((updates[0]!.body as { firstMessage: string }).firstMessage).toBe(greeting);
    expect((await api.request('GET', `${P}/clinics/${C}/vapi`, { authorization: auth })).json().inSync).toBe(true);
    // a save that changes nothing the assistant is built from sends nothing
    vapi.sent.length = 0;
    const again = (await api.request('GET', S, { cookie })).json();
    await api.request('PUT', S, { cookie, body: again });
    await api.vapiIdle();
    expect(vapi.sent).toEqual([]);
  });

  it('makes the assistant again when it was deleted at Vapi, and points the number at it', async () => {
    vapi.gone.add('asst_1');
    vapi.sent.length = 0;
    const res = await api.request('PUT', `${P}/clinics/${C}/vapi`, { body: {}, authorization: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().assistantId).not.toBe('asst_1');
    expect(vapi.sent.map((s) => s.op)).toEqual(['updateAssistant', 'createAssistant', 'updatePhoneNumber']);
  });

  it('removes only the number resource once the location is back on our engine', async () => {
    await api.request('PUT', `${P}/clinics/${C}/voice-engine`, { body: { engine: null }, authorization: auth });
    vapi.sent.length = 0;
    expect((await api.request('DELETE', `${P}/clinics/${C}/vapi`, { authorization: auth })).statusCode).toBe(204);
    expect(vapi.sent).toEqual([{ op: 'deletePhoneNumber', id: 'pn_2' }]);
    const state = await vapiState();
    expect(state.vapi?.phoneNumberId).toBeUndefined();
    expect(state.vapi?.assistantId).toBeTruthy();
    // and switching to Vapi needs the number again
    expect((await api.request('PUT', `${P}/clinics/${C}/voice-engine`, { body: { engine: 'vapi' }, authorization: auth })).statusCode).toBe(409);
  });

  it('says how many Vapi calls are live at once, today\'s peak, the limit and the alert level', async () => {
    for (const id of ['c1', 'c2', 'c3']) await vapiCallLive(api.t.db, id, new Date(), 3);
    const res = (await api.request('GET', `${P}/vapi/concurrency`, { authorization: auth })).json();
    expect(res).toMatchObject({ now: 3, todayPeak: 3, limit: 4, alertAt: 3, alertedAt: expect.any(String) });
  });

  it('gives a location\'s calls per engine with their minutes and voice cost, and its texts', async () => {
    const calls = new CallRepository(api.t.db, createPhiCipher(TEST_DATA_KEY));
    const vapiCall = await calls.open(C, 'vapi_cost_1', '+13035550147', 'phone', undefined, undefined, { engine: 'vapi', voiceFlow: 'tools' });
    await api.t.owner.execute(sql`update calls set started_at = now() - interval '2 minutes' where id = ${vapiCall}`);
    await calls.close(C, vapiCall, { reason: 'customer-ended-call', voiceSeconds: 120, outcome: 'info', emergency: false, usage: { models: {}, engineUsd: 0.25 } });
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const res = await api.request('GET', `${P}/clinics/${C}/costs?from=${from}&to=${to}`, { authorization: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engines).toContainEqual({ engine: 'vapi', calls: 1, minutes: expect.any(Number), voiceUsd: 0.25, totalUsd: expect.any(Number) });
    expect(body.engines.find((e: { engine: string }) => e.engine === 'vapi').minutes).toBeGreaterThanOrEqual(2);
    expect(body).toMatchObject({ texts: expect.any(Number), currency: 'USD', testCalls: { calls: expect.any(Number) } });
    expect(body.breakdown).toContainEqual(expect.objectContaining({ engine: 'vapi', flow: 'tools', channel: 'phone', calls: 1, costed: 1 }));
    expect((await api.request('GET', `${P}/clinics/clinic_none/costs?from=${from}&to=${to}`, { authorization: auth })).statusCode).toBe(404);
  });
});

describe('Vapi not set up', () => {
  it('answers 503 on the Vapi routes, and still reads the concurrency', async () => {
    const api = await startApi({ demoMode: false, provisioningToken: TOKEN });
    try {
      expect((await api.request('PUT', `${P}/clinics/${C}/vapi`, { body: {}, authorization: auth })).json()).toEqual({ error: 'vapi_not_configured' });
      expect((await api.request('GET', `${P}/vapi/concurrency`, { authorization: auth })).json()).toMatchObject({ now: 0, limit: null });
    } finally { await api.close(); }
  });
});
