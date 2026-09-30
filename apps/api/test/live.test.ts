import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LiveActionResult, VoiceClient } from '../src/http/tokens';
import { OTHER, ORIGIN, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'staff' | 'admin' | 'viewer' | 'outsider', string>;

const EVENTS = [
  'event: snapshot\ndata: {"type":"snapshot"}\n\n',
  'id: 1\nevent: caption\ndata: {"type":"caption","speaker":"caller","text":"Hi, this is Maria","atMs":0}\n\n',
  ': heartbeat\n\n',
  'id: 2\nevent: ended\ndata: {"type":"ended","outcome":"booked"}\n\n',
];
const sse = () => new ReadableStream<Uint8Array>({ start(c) { for (const e of EVENTS) c.enqueue(new TextEncoder().encode(e)); c.close(); } });
const done: LiveActionResult = { ok: true, repeat: false };
const voice = {
  browserCalls: false, simulatedCalls: true,
  startTestCall: vi.fn(), endTestCall: vi.fn(), startSimulatedCall: vi.fn(async () => ({ callId: 'sim' })),
  liveCalls: vi.fn(async (_clinicId: string): Promise<Awaited<ReturnType<VoiceClient['liveCalls']>>> => []), // set once the helper's call exists
  liveStream: vi.fn(async (_clinic: string, callId: string) => (callId === api.callId ? sse() : null)),
  coach: vi.fn(async (): Promise<LiveActionResult> => done),
  takeOver: vi.fn(async (): Promise<LiveActionResult> => done),
  endCall: vi.fn(async (): Promise<LiveActionResult> => done),
} satisfies VoiceClient;

const stream = (cookie: string, callId = api.callId, lastEventId?: string) => api.app.getHttpAdapter().getInstance().inject({
  method: 'GET', url: `${C}/calls/${callId}/live`, headers: { cookie, origin: ORIGIN, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
});
const audits = async (action: string) => (await api.t.db.execute(sql`select actor, entity_id, counts from audit_logs where action = ${action} order by id`)).rows as { actor: string; entity_id: string; counts: Record<string, number> | null }[];

beforeAll(async () => {
  api = await startApi({ demoMode: false, voice });
  voice.liveCalls.mockImplementation(async (clinicId: string) => clinicId === DEMO_CLINIC.id ? [
    { callId: api.callId, channel: 'phone' as const, startedAt: new Date().toISOString(), verified: 'Maria D.', doing: 'waiting for a yes', waitingForYes: true, emergency: false },
    { callId: '00000000-0000-4000-8000-000000000002', channel: 'web' as const, startedAt: new Date().toISOString(), verified: null, doing: null, waitingForYes: false, emergency: true },
  ] : []);
  as = {
    staff: await api.signIn('ana@maple.example', true), admin: await api.signIn('olga@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true), outsider: await api.signIn('otto@other.example', true),
  };
});
afterAll(() => api.close());

describe('the live call list', () => {
  it('shows everyone who may list calls what is going on, and names the caller only to those who may read calls', async () => {
    const viewer = (await api.request('GET', `${C}/live`, { cookie: as.viewer })).json();
    expect(viewer.counts).toEqual({ live: 2, emergencies: 1 });
    expect(viewer.calls[0]).toMatchObject({ verified: true, caller: null, doing: 'waiting for a yes', waitingForYes: true });
    expect(JSON.stringify(viewer)).not.toContain('Maria');
    expect(await audits('calls.live.listed')).toEqual([]);

    const staff = (await api.request('GET', `${C}/live`, { cookie: as.staff })).json();
    expect(staff.calls[0].caller).toBe('Maria D.');
    await api.request('GET', `${C}/live`, { cookie: as.staff });
    expect((await audits('calls.live.listed')).map((a) => a.actor)).toEqual([`user:${api.users.staff}`]); // once per five minutes
  });

  it('is another clinic\'s own business', async () => {
    expect((await api.request('GET', `${C}/live`, { cookie: as.outsider })).statusCode).toBe(404);
    expect((await api.request('GET', `/api/v1/clinics/${OTHER.id}/live`, { cookie: as.outsider })).json().counts).toEqual({ live: 0, emergencies: 0 });
  });
});

describe('watching a live call', () => {
  it('streams the voice service\'s events, heartbeats included, and audits the watch once', async () => {
    const res = await stream(as.staff);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-transform');
    expect(res.body).toBe(EVENTS.join(''));
    expect(res.body).toContain(': heartbeat');
    // a reconnect within five minutes is the same watch
    await stream(as.staff, api.callId, '1');
    expect(voice.liveStream).toHaveBeenLastCalledWith(DEMO_CLINIC.id, api.callId, '1', expect.any(AbortSignal));
    expect(await audits('call.live.watched')).toEqual([{ actor: `user:${api.users.staff}`, entity_id: api.callId, counts: null }]);
  });

  it('audits a stream opened with a Last-Event-ID too: the client cannot skip the audit', async () => {
    await stream(as.admin, api.callId, '42');
    expect((await audits('call.live.watched')).filter((a) => a.actor === `user:${api.users.admin}`)).toEqual([{ actor: `user:${api.users.admin}`, entity_id: api.callId, counts: null }]);
    // after five minutes, the same person watching again is a new row
    await api.t.db.execute(sql`update audit_logs set at = at - interval '6 minutes' where action = 'call.live.watched'`);
    await stream(as.admin, api.callId, '43');
    expect((await audits('call.live.watched')).filter((a) => a.actor === `user:${api.users.admin}`)).toHaveLength(2);
  });

  it('needs calls:read, the clinic\'s own call, and a call that is live', async () => {
    expect((await stream(as.viewer)).statusCode).toBe(403);
    expect((await stream(as.outsider)).statusCode).toBe(404);
    expect((await stream(as.staff, '00000000-0000-4000-8000-00000000ffff')).statusCode).toBe(404); // not this clinic's call
    const other = (await api.t.db.execute(sql`insert into calls (clinic_id, openai_session_id) values (${DEMO_CLINIC.id}, 'live_not_live') returning id`)).rows[0] as { id: string };
    const notLive = await stream(as.staff, other.id);
    expect(notLive.statusCode).toBe(404);
    expect(notLive.json()).toEqual({ error: 'not_live' });
    expect((await stream(as.staff, 'not-a-uuid')).statusCode).toBe(404);
  });
});

describe('staff actions', () => {
  const act = (path: string, cookie: string, body: unknown) => api.request('POST', `${C}/calls/${api.callId}/live/${path}`, { cookie, body });

  it('a coaching note goes to the assistant and is audited with its length, never its words', async () => {
    expect((await act('coach', as.viewer, { note: 'offer Thursday', key: 'coach-key-1' })).statusCode).toBe(403);
    expect((await act('coach', as.staff, { note: 'x'.repeat(301), key: 'coach-key-2' })).statusCode).toBe(422);
    expect((await act('coach', as.staff, { note: 'offer Thursday afternoon', key: 'coach-key-3' })).statusCode).toBe(202);
    expect(voice.coach).toHaveBeenLastCalledWith(DEMO_CLINIC.id, api.callId, { userId: api.users.staff, byName: 'Ana Front', key: 'coach-key-3', note: 'offer Thursday afternoon' });
    voice.coach.mockResolvedValueOnce({ ok: true, repeat: true });
    await act('coach', as.staff, { note: 'offer Thursday afternoon', key: 'coach-key-3' });
    const rows = await audits('call.coached');
    expect(rows).toEqual([{ actor: `user:${api.users.staff}`, entity_id: api.callId, counts: { characters: 24 } }]);
    expect(JSON.stringify(await api.t.db.execute(sql`select * from audit_logs`))).not.toContain('Thursday');
  });

  it('taking over goes to the front desk, or to your own number once you have given one', async () => {
    expect((await act('take-over', as.staff, { target: 'front_desk', key: 'take-key-1' })).statusCode).toBe(202);
    expect(voice.takeOver).toHaveBeenLastCalledWith(DEMO_CLINIC.id, api.callId, { userId: api.users.staff, byName: 'Ana Front', key: 'take-key-1', target: { kind: 'front_desk' } });
    expect((await act('take-over', as.admin, { target: 'me', key: 'take-key-2' })).json()).toEqual({ error: 'no_number' });
    expect((await api.request('PUT', `${C}/my-transfer-number`, { cookie: as.admin, body: { number: '3035550123' } })).statusCode).toBe(422);
    expect((await api.request('PUT', `${C}/my-transfer-number`, { cookie: as.admin, body: { number: '+13035550123' } })).statusCode).toBe(200);
    expect((await api.request('GET', `${C}/my-transfer-number`, { cookie: as.admin })).json()).toEqual({ number: '+13035550123' });
    await act('take-over', as.admin, { target: 'me', key: 'take-key-3' });
    expect(voice.takeOver).toHaveBeenLastCalledWith(DEMO_CLINIC.id, api.callId, { userId: api.users.admin, byName: 'Olga Admin', key: 'take-key-3', target: { kind: 'number', number: '+13035550123' } });
    expect((await audits('call.taken_over')).map((a) => a.actor)).toEqual([`user:${api.users.staff}`, `user:${api.users.admin}`]);
  });

  it('keeps own numbers in the clinic\'s country, audits a change, and records a take-over\'s destination by its last four digits', async () => {
    const foreign = await api.request('PUT', `${C}/my-transfer-number`, { cookie: as.admin, body: { number: '+8801711000123' } });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().issues[0]).toMatchObject({ path: 'number', message: expect.stringContaining('+1') });
    expect((await api.request('PUT', `${C}/my-transfer-number`, { cookie: as.admin, body: { number: '+13035550987' } })).statusCode).toBe(200);
    expect((await api.request('PUT', `${C}/my-transfer-number`, { cookie: as.admin, body: { number: null } })).statusCode).toBe(200);
    expect((await audits('member.transfer_number.set')).length).toBeGreaterThanOrEqual(2);
    expect(await audits('member.transfer_number.cleared')).toEqual([{ actor: `user:${api.users.admin}`, entity_id: api.users.admin, counts: null }]);
    const rows = await audits('call.taken_over');
    expect(rows.map((r) => r.counts)).toEqual([{ ownNumber: 0, destinationLast4: 101 }, { ownNumber: 1, destinationLast4: 123 }]);
    expect(JSON.stringify(await api.t.db.execute(sql`select * from audit_logs where action like 'call.%' or action like 'member.transfer%'`))).not.toMatch(/3035550(123|987|101)/);
  });

  it('tells the second person who already has the call, and why a browser call cannot be transferred', async () => {
    voice.endCall.mockResolvedValueOnce({ ok: false, status: 409, error: 'already_taken', by: api.users.staff });
    const taken = await act('end', as.admin, { key: 'end-key-1' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'already_taken', by: 'Ana Front' });
    voice.takeOver.mockResolvedValueOnce({ ok: false, status: 409, error: 'web_call' });
    expect((await act('take-over', as.staff, { target: 'front_desk', key: 'take-key-4' })).json()).toEqual({ error: 'web_call' });
    voice.endCall.mockResolvedValueOnce({ ok: false, status: 404, error: 'not_live' });
    expect((await act('end', as.staff, { key: 'end-key-2' })).statusCode).toBe(404);
    expect(await audits('call.ended_by_staff')).toEqual([]);
    expect((await act('end', as.staff, { key: 'end-key-3' })).statusCode).toBe(202);
    expect((await audits('call.ended_by_staff')).map((a) => a.actor)).toEqual([`user:${api.users.staff}`]);
  });

  it('writes the audit row before the action: when the row cannot be written, the assistant is never told', async () => {
    const calls = voice.coach.mock.calls.length;
    await api.t.db.execute(sql`revoke insert on audit_logs from attendra_app`);
    try {
      const res = await act('coach', as.staff, { note: 'offer Friday', key: 'coach-key-9' });
      expect(res.statusCode).toBe(500);
    } finally {
      await api.t.db.execute(sql`grant insert on audit_logs to attendra_app`);
    }
    expect(voice.coach.mock.calls.length).toBe(calls);
  });

  it('a simulated call starts only where the voice service offers them', async () => {
    const res = await api.request('POST', `${C}/test-calls/simulated`, { cookie: as.staff });
    expect(res.statusCode).toBe(201);
    expect((await api.request('GET', '/api/v1/me', { cookie: as.staff })).json()).toMatchObject({ testCalls: false, simulatedCalls: true });
  });
});
