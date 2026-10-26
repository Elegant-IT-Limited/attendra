import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signedToken } from '../src/http/rate-key';
import { startApi } from './helpers';

// a small budget, so the test reaches it quickly; the real one is 600 a minute
const MAX = 12;
let api: Awaited<ReturnType<typeof startApi>>;
let owner: string;
let staff: string;

beforeAll(async () => {
  api = await startApi({ demoMode: true, rateLimit: MAX });
  owner = await api.signIn('omar@maple.example');
  staff = await api.signIn('ana@maple.example');
});
afterAll(() => api.close());

/** Requests until the first 429, from one office address; the number that went through. */
async function budget(cookie: string | undefined) {
  for (let i = 0; i < MAX * 2; i++) {
    const res = await api.request('GET', '/api/v1/health', cookie ? { cookie } : {});
    if (res.statusCode === 429) {
      expect(res.json()).toEqual({ error: 'rate_limited' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      return i;
    }
  }
  return Infinity;
}

describe("the API's per-minute limit", () => {
  it('counts each signed-in person on their own, so a team on one office connection is not one budget', async () => {
    // sign-in itself used the address's budget; each session starts its own
    expect(await budget(owner)).toBe(MAX);
    expect(await budget(staff)).toBe(MAX);
  });

  it('counts by address without a session, and a made-up session cookie does not buy a fresh budget', async () => {
    const left = await budget(undefined);
    expect(left).toBeLessThan(MAX);
    const name = owner.split('=')[0]!;
    expect(await budget(`${name}=${encodeURIComponent('made-up-token.' + Buffer.alloc(32, 1).toString('base64'))}`)).toBe(0);
  });

  it('reads only a cookie this server signed', () => {
    const [name, value] = owner.split('; ').find((c) => c.includes('session_token'))!.split('=') as [string, string];
    const secret = 'test-secret-that-is-at-least-32-characters';
    expect(signedToken(`a=b; ${name}=${value}`, name, secret)).toBe(decodeURIComponent(value).split('.')[0]);
    expect(signedToken(`${name}=${value}`, name, 'another-secret-that-is-at-least-32-characters')).toBeNull();
    expect(signedToken(`${name}=nodot`, name, secret)).toBeNull();
    expect(signedToken(undefined, name, secret)).toBeNull();
  });
});
