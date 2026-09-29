import { DEMO_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config';
import { httpVoiceClient } from '../src/voice';
import { OTHER, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
let viewer: string;
const voice = { startTestCall: vi.fn(), endTestCall: vi.fn(async () => {}) };

beforeAll(async () => {
  api = await startApi({ demoMode: false, voice });
  staff = await api.signIn('ana@maple.example', true);
  viewer = await api.signIn('vic@maple.example', true);
  // what the voice service does before it answers: open the call row, audited
  voice.startTestCall.mockImplementation(async (clinicId: string, userId: string) => ({
    callId: await new CallRepository(api.t.db, createPhiCipher(TEST_DATA_KEY)).open(clinicId, `live_web_${Date.now()}`, null, 'web', userId),
    sdp: 'v=0 answer',
    maxSeconds: 300,
  }));
});
afterAll(() => api.close());

describe('browser test calls', () => {
  it('hands the offer to the voice service with who asked, and the call is audited and marked', async () => {
    const res = await api.request('POST', `${C}/test-calls`, { cookie: staff, body: { sdp: 'v=0 offer' } });
    expect(res.statusCode).toBe(201);
    const { callId, sdp, maxSeconds } = res.json();
    expect({ sdp, maxSeconds }).toEqual({ sdp: 'v=0 answer', maxSeconds: 300 });
    expect(voice.startTestCall).toHaveBeenCalledWith(DEMO_CLINIC.id, api.users.staff, 'v=0 offer');
    const audit = (await api.request('GET', `${C}/audit`, { cookie: await api.signIn('olga@maple.example', true) })).json();
    expect(audit.entries[0]).toMatchObject({ action: 'call.test.started', callId, actor: `user:${api.users.staff}` });
    const list = (await api.request('GET', `${C}/calls`, { cookie: staff })).json();
    expect(list.calls.find((c: { id: string }) => c.id === callId)).toMatchObject({ channel: 'web' });
    expect((await api.request('GET', '/api/v1/me', { cookie: staff })).json().testCalls).toBe(true);
  });

  it('ends a call the page could not end itself', async () => {
    const res = await api.request('POST', `${C}/test-calls/call_1/end`, { cookie: staff });
    expect(res.statusCode).toBe(202);
    expect(voice.endTestCall).toHaveBeenCalledWith(DEMO_CLINIC.id, 'call_1');
  });

  it('is closed to viewers, other clinics, cross-origin writes and empty offers', async () => {
    expect((await api.request('POST', `${C}/test-calls`, { cookie: viewer, body: { sdp: 'v=0' } })).statusCode).toBe(403);
    expect((await api.request('POST', `/api/v1/clinics/${OTHER.id}/test-calls`, { cookie: staff, body: { sdp: 'v=0' } })).statusCode).toBe(404);
    expect((await api.request('POST', `${C}/test-calls`, { cookie: staff, body: { sdp: 'v=0' }, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/test-calls`, { cookie: staff, body: { sdp: '' } })).statusCode).toBe(400);
    expect((await api.request('POST', `${C}/test-calls/call_1/end`, { cookie: viewer })).statusCode).toBe(403);
  });

  it('passes on the per-clinic limit, and says so when the voice service is down', async () => {
    voice.startTestCall.mockRejectedValueOnce(Object.assign(new Error('refused'), { status: 429 }));
    const limited = await api.request('POST', `${C}/test-calls`, { cookie: staff, body: { sdp: 'v=0 offer' } });
    expect([limited.statusCode, limited.json()]).toEqual([429, { error: 'test_call_limit' }]);
    voice.startTestCall.mockRejectedValueOnce(Object.assign(new Error('refused'), { status: 502 }));
    const down = await api.request('POST', `${C}/test-calls`, { cookie: staff, body: { sdp: 'v=0 offer' } });
    expect([down.statusCode, down.json()]).toEqual([502, { error: 'voice_unavailable' }]);
  });
});

it('answers 503 on a deployment without a voice service, and /me says test calls are off', async () => {
  const bare = await startApi({ demoMode: true });
  try {
    const cookie = await bare.signIn('ana@maple.example');
    const res = await bare.request('POST', `${C}/test-calls`, { cookie, body: { sdp: 'v=0 offer' } });
    expect([res.statusCode, res.json()]).toEqual([503, { error: 'voice_not_configured' }]);
    expect((await bare.request('GET', '/api/v1/me', { cookie })).json().testCalls).toBe(false);
  } finally {
    await bare.close();
  }
});

describe('the voice client', () => {
  it('sends the token, keeps a path prefix, and turns a refusal into its status', async () => {
    const seen: { url?: string; auth?: string; body?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body });
        if (req.url?.endsWith('/end')) { res.writeHead(404).end(); return; }
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ callId: 'c1', sdp: 'v=0', maxSeconds: 300 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const client = httpVoiceClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/voice/`, 't'.repeat(32));
      expect(await client.startTestCall('clinic_maple', 'u1', 'v=0 offer')).toEqual({ callId: 'c1', sdp: 'v=0', maxSeconds: 300 });
      await expect(client.endTestCall('clinic_maple', 'c1')).rejects.toMatchObject({ status: 404 });
      expect(seen[0]).toEqual({ url: '/voice/internal/web-calls', auth: `Bearer ${'t'.repeat(32)}`, body: JSON.stringify({ clinicId: 'clinic_maple', userId: 'u1', sdp: 'v=0 offer' }) });
      expect(seen[1]!.url).toBe('/voice/internal/web-calls/c1/end');
    } finally {
      server.close();
    }
  });
});

describe('API environment', () => {
  const base = { DATABASE_URL: 'postgres://a:b@localhost:5432/c', ATTENDRA_DATA_KEY: 'x'.repeat(44), BETTER_AUTH_SECRET: 's'.repeat(32) };
  it('treats empty voice settings as off, and refuses half of them', () => {
    expect(loadEnv({ ...base, VOICE_URL: '', VOICE_INTERNAL_TOKEN: '' }).VOICE_URL).toBeUndefined();
    expect(() => loadEnv({ ...base, VOICE_URL: 'http://voice:8080' })).toThrow('VOICE_URL');
    expect(() => loadEnv({ ...base, VOICE_URL: 'http://voice:8080', VOICE_INTERNAL_TOKEN: 'short' })).toThrow('VOICE_INTERNAL_TOKEN');
  });
});
