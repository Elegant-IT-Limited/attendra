import { DEMO_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler } from '@attendra/scheduling';
import { SimulatedEngine } from '@attendra/voice-engine';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveRegistry } from '../src/live';
import { buildServer, type VoiceDeps } from '../src/server';
import { simulatedCallFor } from '../src/simulated-calls';

const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const TOKEN = 'a-long-internal-token-for-the-tests-only';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const control = { coach: async () => {}, takeOver: async () => {}, end: async () => {}, canEnd: () => true };

describe('the live registry', () => {
  it('lists a clinic\'s open calls and keeps a replay buffer for Last-Event-ID', () => {
    const live = new LiveRegistry(3);
    live.open('c1', { clinicId: 'k1', channel: 'phone', startedAt: new Date('2026-09-30T10:00:00Z') }, control);
    live.open('c2', { clinicId: 'k2', channel: 'web', startedAt: new Date() }, control);
    for (let i = 1; i <= 5; i++) live.publish('c1', { type: 'caption', speaker: 'caller', text: `part ${i}`, atMs: i });
    live.publish('c1', { type: 'state', verified: 'Maria D.', pending: 'Tuesday at 8', doing: 'waiting for a yes' });
    expect(live.list('k1')).toEqual([{ callId: 'c1', channel: 'phone', startedAt: '2026-09-30T10:00:00.000Z', verified: 'Maria D.', doing: 'waiting for a yes', waitingForYes: true, emergency: false }]);
    expect(live.list('k2').map((c) => c.callId)).toEqual(['c2']);

    const seen: number[] = [];
    const stop = live.subscribe('k1', 'c1', 4, (n) => seen.push(n.id))!;
    expect(seen).toEqual([0, 5, 6]); // the snapshot, then what came after event 4, from a buffer of three
    live.publish('c1', { type: 'emergency', kind: 'cardiac' });
    expect(seen).toEqual([0, 5, 6, 7]);
    stop();
    expect(live.subscribe('k2', 'c1', null, () => {})).toBeNull(); // another clinic's call is not there
  });

  it('ends a call with a last event, and a late watcher still sees it', () => {
    const live = new LiveRegistry();
    live.open('c1', { clinicId: 'k1', channel: 'phone', startedAt: new Date() }, control);
    live.end('c1', 'booked');
    expect(live.list('k1')).toEqual([]);
    const types: string[] = [];
    live.subscribe('k1', 'c1', null, (n) => types.push(n.event.type));
    expect(types).toEqual(['snapshot', 'ended']);
  });

  it('gives a call to the first person who takes it; the same click twice is one action', async () => {
    const live = new LiveRegistry();
    let runs = 0;
    live.open('c1', { clinicId: 'k1', channel: 'phone', startedAt: new Date() }, control);
    const run = async () => { runs++; };
    expect(await live.claim('k1', 'c1', 'key-aaaa', 'u_ana', 'take_over', run)).toEqual({ ok: true, repeat: false });
    expect(await live.claim('k1', 'c1', 'key-aaaa', 'u_ana', 'take_over', run)).toEqual({ ok: true, repeat: true });
    expect(await live.claim('k1', 'c1', 'key-bbbb', 'u_jo', 'end', run)).toEqual({ ok: false, error: 'already_taken', by: 'u_ana' });
    expect(runs).toBe(1);
    live.open('w1', { clinicId: 'k1', channel: 'web', startedAt: new Date() }, control);
    expect(await live.claim('k1', 'w1', 'key-cccc', 'u_ana', 'take_over', run)).toEqual({ ok: false, error: 'web_call' });
    expect(await live.claim('k2', 'c1', 'key-dddd', 'u_ana', 'end', run)).toEqual({ ok: false, error: 'not_live' });
  });

  it('refuses End call until the emergency script is said, and a failed transfer frees the call for anyone', async () => {
    const live = new LiveRegistry();
    let heard = false;
    let runs = 0;
    const run = async () => { runs++; };
    live.open('c1', { clinicId: 'k1', channel: 'phone', startedAt: new Date() }, { ...control, canEnd: () => heard });
    expect(await live.claim('k1', 'c1', 'key-aaaa', 'u_ana', 'end', run)).toEqual({ ok: false, error: 'emergency_script' });
    expect(await live.claim('k1', 'c1', 'key-bbbb', 'u_ana', 'take_over', run)).toEqual({ ok: true, repeat: false });
    live.publish('c1', { type: 'staff', action: 'transfer_failed' });
    heard = true;
    expect(await live.claim('k1', 'c1', 'key-cccc', 'u_jo', 'end', run)).toEqual({ ok: true, repeat: false });
    expect(runs).toBe(2);
  });
});

describe('a simulated live call, over HTTP', () => {
  let t: Awaited<ReturnType<typeof openTestDatabase>>;
  let app: ReturnType<typeof buildServer>;
  let base: string;
  const engine = new SimulatedEngine();

  beforeAll(async () => {
    t = await openTestDatabase();
    const cipher = createPhiCipher(TEST_DATA_KEY);
    await seedDemo(t.db, cipher);
    const calls = new CallRepository(t.db, cipher);
    const deps: VoiceDeps = {
      verifyWebhook: async () => { throw new Error('no webhooks here'); },
      claimDelivery: async () => true,
      clinicForNumber: async () => DEMO_CLINIC,
      clinicById: async (id) => (id === DEMO_CLINIC.id ? DEMO_CLINIC : null),
      openCall: (clinicId, sessionId, from, channel, startedBy) => calls.open(clinicId, sessionId, from, channel, startedBy),
      recorderFor: (clinicId, callId) => ({ appendSegment: (s) => calls.appendSegment(clinicId, callId, s), close: (c) => calls.close(clinicId, callId, c) }),
      actionsFor: () => ({ record: async () => {} }),
      engine,
      backend: {
        patients: new PostgresPatientDirectory(t.db, cipher), scheduler: new BuiltinScheduler(t.db), tasks: new PostgresTaskQueue(t.db, cipher),
        audit: new PostgresAuditLog(t.db), messenger: { sendTemplate: async () => {} },
      },
      planner: { plan: async () => ({ say: null }) },
      log, internalToken: TOKEN, liveHeartbeatSeconds: 1,
      simulator: { engine, callFor: (c) => { const s = simulatedCallFor(c); return s ? { ...s, script: { ...s.script, pace: 50 } } : null; } },
    };
    app = buildServer(deps);
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app.close(); await t.close(); });

  const post = (path: string, body: unknown, headers: Record<string, string> = auth) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  /** Reads Server-Sent Events until `until` says stop. */
  async function read(path: string, until: (events: { event: string; id?: string; data: Record<string, unknown> }[], raw: string) => boolean, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${path}`, { headers: { authorization: auth.authorization, ...headers } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    const events: { event: string; id?: string; data: Record<string, unknown> }[] = [];
    const deadline = Date.now() + 15_000;
    while (!until(events, raw) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      events.length = 0;
      for (const block of raw.split('\n\n')) {
        const lines = block.split('\n');
        const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
        const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
        if (event && data) events.push({ event, id: lines.find((l) => l.startsWith('id: '))?.slice(4), data: JSON.parse(data) });
      }
    }
    await reader.cancel();
    return { events, raw };
  }

  it('refuses every live route without the internal token', async () => {
    expect((await fetch(`${base}/internal/live?clinicId=${DEMO_CLINIC.id}`)).status).toBe(401);
    expect((await fetch(`${base}/internal/live/any?clinicId=${DEMO_CLINIC.id}`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await post('/internal/live/any/coach', { clinicId: DEMO_CLINIC.id, userId: 'u', key: 'key-12345', note: 'x' }, { 'content-type': 'application/json' })).status).toBe(401);
    expect((await post('/internal/simulated-calls', { clinicId: DEMO_CLINIC.id, userId: 'u' }, { 'content-type': 'application/json' })).status).toBe(401);
  });

  it('streams the call as it happens, takes a coaching note over the sideband, refuses a take-over of a browser call, and ends', async () => {
    const started = await post('/internal/simulated-calls', { clinicId: DEMO_CLINIC.id, userId: 'u_ana' });
    expect(started.status).toBe(201);
    const { callId } = await started.json() as { callId: string };
    const listed = await (await fetch(`${base}/internal/live?clinicId=${DEMO_CLINIC.id}`, { headers: auth })).json() as { calls: { callId: string; channel: string }[] };
    expect(listed.calls).toContainEqual(expect.objectContaining({ callId, channel: 'web' }));
    expect((await fetch(`${base}/internal/live/${callId}?clinicId=clinic_other`, { headers: auth })).status).toBe(404);

    // watch until the assistant is waiting for a yes
    const first = await read(`/internal/live/${callId}?clinicId=${DEMO_CLINIC.id}`, (ev) => ev.some((e) => e.event === 'state' && e.data.doing === 'waiting for a yes'));
    expect(first.events[0]).toMatchObject({ event: 'snapshot' });
    expect(first.events.some((e) => e.event === 'caption' && e.data.speaker === 'caller')).toBe(true);
    expect(first.events).toContainEqual(expect.objectContaining({ event: 'tool', data: { type: 'tool', tool: 'verify_caller', status: 'ok', code: null } }));
    expect(first.events.find((e) => e.event === 'state' && e.data.verified)?.data.verified).toBe('Maria D.');
    const lastId = first.events.filter((e) => e.id).at(-1)!.id!;

    // a coaching note reaches the voice model as a marked instruction
    const coached = await post(`/internal/live/${callId}/coach`, { clinicId: DEMO_CLINIC.id, userId: 'u_ana', key: 'coach-key-1', note: 'offer Thursday afternoon' });
    expect(coached.status).toBe(202);
    expect((await post(`/internal/live/${callId}/coach`, { clinicId: DEMO_CLINIC.id, userId: 'u_ana', key: 'coach-key-1', note: 'offer Thursday afternoon' })).status).toBe(200);
    const session = [...(engine as unknown as { sessions: Map<string, unknown> }).sessions.keys()].at(-1)!;
    const notes = engine.sentTo(session).filter((c) => (c as { content?: string }).content?.includes('offer Thursday afternoon'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: 'session.instructions.append', delegation_id: null });

    const takeOver = await post(`/internal/live/${callId}/take-over`, { clinicId: DEMO_CLINIC.id, userId: 'u_ana', key: 'take-key-1', target: { kind: 'front_desk' } });
    expect(takeOver.status).toBe(409);
    expect(await takeOver.json()).toEqual({ error: 'web_call' });

    // a watcher who reconnects gets what came after its last event, then the end
    const ending = read(`/internal/live/${callId}?clinicId=${DEMO_CLINIC.id}`, (ev) => ev.some((e) => e.event === 'ended'), { 'last-event-id': lastId });
    expect((await post(`/internal/live/${callId}/end`, { clinicId: DEMO_CLINIC.id, userId: 'u_ana', key: 'end-key-1' })).status).toBe(202);
    const again = await post(`/internal/live/${callId}/end`, { clinicId: DEMO_CLINIC.id, userId: 'u_jo', key: 'end-key-2' });
    expect([409, 404]).toContain(again.status); // someone already has it, or it is already over
    const { events } = await ending;
    expect(events[0]!.event).toBe('snapshot');
    expect(events.filter((e) => e.id).every((e) => Number(e.id) > Number(lastId))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ event: 'staff', data: { type: 'staff', action: 'ended' } }));
    expect(events.at(-1)).toMatchObject({ event: 'ended' });
    const after = await (await fetch(`${base}/internal/live?clinicId=${DEMO_CLINIC.id}`, { headers: auth })).json() as { calls: unknown[] };
    expect(after.calls).toEqual([]);
  }, 30_000);

  it('sends a heartbeat while nothing happens', async () => {
    const { callId } = await (await post('/internal/simulated-calls', { clinicId: DEMO_CLINIC.id, userId: 'u_ana' })).json() as { callId: string };
    const { raw } = await read(`/internal/live/${callId}?clinicId=${DEMO_CLINIC.id}`, (_ev, r) => r.includes(': heartbeat'));
    expect(raw).toContain(': heartbeat');
    await post(`/internal/live/${callId}/end`, { clinicId: DEMO_CLINIC.id, userId: 'u_ana', key: 'end-key-3' });
  }, 20_000);
});

describe('taking over a phone call', () => {
  it('transfers once, to the front desk, and tells anyone else it is taken', async () => {
    const engine = new SimulatedEngine();
    const transfers: string[] = [];
    const real = engine.transfer.bind(engine);
    engine.transfer = async (sessionId: string, uri: string) => { transfers.push(uri); return real(sessionId); };
    engine.create({ turns: [{ assistant: 'Hello.' }] }, 'live_phone_1');
    const app = buildServer({
      verifyWebhook: async (raw) => JSON.parse(raw), claimDelivery: async () => true,
      clinicForNumber: async () => DEMO_CLINIC, clinicById: async () => DEMO_CLINIC,
      openCall: async () => '00000000-0000-4000-8000-00000000abcd',
      recorderFor: () => ({ appendSegment: async () => {}, close: async () => {} }), actionsFor: () => ({ record: async () => {} }),
      engine, backend: {} as never, planner: { plan: async () => ({ say: null }) }, log, internalToken: TOKEN,
    });
    await app.inject({ method: 'POST', url: '/webhooks/openai', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'wh_1', type: 'live.transport.incoming', data: { session_id: 'live_phone_1', sip_headers: [{ name: 'To', value: '<sip:+13035550100@x>' }] } }) });
    await new Promise((r) => setTimeout(r, 50));
    const callId = '00000000-0000-4000-8000-00000000abcd';
    const take = (key: string, userId: string) => app.inject({ method: 'POST', url: `/internal/live/${callId}/take-over`, headers: auth, payload: JSON.stringify({ clinicId: DEMO_CLINIC.id, userId, key, target: { kind: 'front_desk' } }) });
    const [a, b] = await Promise.all([take('take-key-a', 'u_ana'), take('take-key-b', 'u_jo')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    const [winner, loser] = a.statusCode === 202 ? ['u_ana', b] as const : ['u_jo', a] as const;
    expect(loser.json()).toEqual({ error: 'already_taken', by: winner });
    await new Promise((r) => setTimeout(r, 3800)); // the assistant says the line first
    expect(transfers).toEqual(['tel:+13035550101']);
    await app.close();
  }, 15_000);
});
