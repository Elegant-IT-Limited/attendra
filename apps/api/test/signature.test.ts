import { DEMO_CLINIC } from '@attendra/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mailHook } from '../src/mail-hook';
import { checkSignature, SIGNATURE_EXAMPLE, SIGNATURE_HEADER, SIGNATURE_WINDOW_S, signRequest, TIMESTAMP_HEADER } from '../src/http/signature';
import { startApi } from './helpers';

/**
 * Provisioning requests signed with the shared token, so the token itself need not travel:
 * the format pinned by a fixed example (the hosting layer's copy checks the same one), the
 * window, a signature for one request never valid for another, and the two modes.
 */
const TOKEN = 'p'.repeat(40);
const P = '/api/v1/provisioning';
const C = DEMO_CLINIC.id;

describe('the signature format', () => {
  it('matches the fixed example both sides check', () => {
    const { key, method, path, body, at, headers } = SIGNATURE_EXAMPLE;
    expect(signRequest(key, { method, path, body }, at)).toEqual(headers);
    expect(checkSignature(key, { method, path, body, headers }, at)).toBe('valid');
  });

  it('is good for that request only, and only for a few minutes', () => {
    const { key, method, path, body, at, headers } = SIGNATURE_EXAMPLE;
    expect(checkSignature(key, { method, path, body: `${body} `, headers }, at)).toBe('invalid');
    expect(checkSignature(key, { method, path: '/api/v1/provisioning/accounts', body, headers }, at)).toBe('invalid');
    expect(checkSignature(key, { method: 'PUT', path, body, headers }, at)).toBe('invalid');
    expect(checkSignature('another-key-of-forty-characters-0123456', { method, path, body, headers }, at)).toBe('invalid');
    expect(checkSignature(key, { method, path, body, headers }, new Date(at.getTime() + (SIGNATURE_WINDOW_S + 1) * 1000))).toBe('stale');
    expect(checkSignature(key, { method, path, body, headers }, new Date(at.getTime() - (SIGNATURE_WINDOW_S + 1) * 1000))).toBe('stale');
    expect(checkSignature(key, { method, path, body, headers: {} }, at)).toBe('missing');
    expect(checkSignature(key, { method, path, body, headers: { [TIMESTAMP_HEADER]: headers[TIMESTAMP_HEADER], [SIGNATURE_HEADER]: 'v1=zz' } }, at)).toBe('invalid');
  });
});

describe('provisioning, while the hosting layer moves over (accept)', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeAll(async () => { api = await startApi({ demoMode: false, twoFactor: 'optional', provisioningToken: TOKEN }); });
  afterAll(() => api.close());
  const path = `${P}/clinics/${C}/voice-engine`;
  const body = { engine: null };

  it('takes the bearer token, or a signature made with it and no token at all', async () => {
    expect((await api.request('PUT', path, { body, authorization: `Bearer ${TOKEN}` })).statusCode).toBe(204);
    const signed = signRequest(TOKEN, { method: 'PUT', path, body: JSON.stringify(body) });
    expect((await api.request('PUT', path, { body, headers: signed })).statusCode).toBe(204);
  });

  it('refuses a bad or old signature even with the right bearer token beside it', async () => {
    const forOther = signRequest(TOKEN, { method: 'PUT', path, body: JSON.stringify({ engine: 'gpt-realtime' }) });
    const res = await api.request('PUT', path, { body, headers: forOther, authorization: `Bearer ${TOKEN}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('bad_signature');
    const old = signRequest(TOKEN, { method: 'PUT', path, body: JSON.stringify(body) }, new Date(Date.now() - 3_600_000));
    expect((await api.request('PUT', path, { body, headers: old, authorization: `Bearer ${TOKEN}` })).json().error).toBe('signature_expired');
  });
});

describe('provisioning once every request is signed (require)', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeAll(async () => { api = await startApi({ demoMode: false, twoFactor: 'optional', provisioningToken: TOKEN, provisioningSignatures: 'require' }); });
  afterAll(() => api.close());
  const path = `${P}/clinics/${C}/voice-engine`;

  it('refuses the bearer token alone, and takes a signed request', async () => {
    const bare = await api.request('PUT', path, { body: { engine: null }, authorization: `Bearer ${TOKEN}` });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error).toBe('signature_required');
    const signed = signRequest(TOKEN, { method: 'PUT', path, body: JSON.stringify({ engine: null }) });
    expect((await api.request('PUT', path, { body: { engine: null }, headers: signed })).statusCode).toBe(204);
  });

  it('a body-less request signs the empty body, its query included', async () => {
    const res = await api.request('DELETE', `${P}/clinics/clinic_none?force=1`, { headers: signRequest(TOKEN, { method: 'DELETE', path: `${P}/clinics/clinic_none?force=1` }) });
    expect(res.statusCode).not.toBe(401);
  });
});

describe('the mail hook, the other way', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs what it posts with the same token, over the hook\'s own path', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(null, { status: 204 }); });
    await mailHook('https://cloud.example/account/api/engine-mail?v=1', TOKEN)({ type: 'password_reset', email: 'ana@maple.example', name: 'Ana', emailVerified: true, url: 'https://app.example/reset-password?token=x' });
    const { init } = sent[0]!;
    const headers = init.headers as Record<string, string>;
    expect(checkSignature(TOKEN, { method: 'POST', path: '/account/api/engine-mail?v=1', body: init.body as string, headers })).toBe('valid');
  });
});
