import { DEMO_CLINIC, twoFactorRoles } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config';
import { startApi } from './helpers';

// ATTENDRA_TWO_FACTOR=managers: owners and practice managers must use two-step sign-in, the others may.
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let owner = '';

beforeAll(async () => { api = await startApi({ demoMode: false, twoFactor: 'managers' }); });
afterAll(() => api.close());

const me = async (cookie: string) => (await api.request('GET', '/api/v1/me', { cookie })).json();
const calls = (cookie: string) => api.request('GET', `${C}/calls`, { cookie });

describe('two-step sign-in required of owners and practice managers only', () => {
  it('stops an owner and a practice manager without it at "who am I", and says why', async () => {
    for (const email of ['omar@maple.example', 'olga@maple.example']) {
      const cookie = await api.signIn(email);
      const who = await me(cookie);
      expect(who.twoFactorRequired, email).toBe(true);
      expect(who.twoFactorRoles).toEqual(['owner', 'admin']);
      const res = await calls(cookie);
      expect(res.statusCode, email).toBe(403);
      expect(res.json().error).toBe('two_factor_required');
    }
  });

  it('lets front desk and a viewer work without it, and says it is their choice', async () => {
    for (const email of ['ana@maple.example', 'vic@maple.example']) {
      const cookie = await api.signIn(email);
      expect((await me(cookie)).twoFactorRequired, email).toBe(false);
      expect((await calls(cookie)).statusCode, email).toBe(200);
    }
  });

  it('lets an owner in once it is on', async () => {
    owner = await api.signIn('omar@maple.example', true);
    expect((await calls(owner)).statusCode).toBe(200);
    expect((await me(owner)).twoFactorRequired).toBe(true);
  });

  it('asks front desk made practice manager for it at their next request', async () => {
    const ana = await api.signIn('ana@maple.example');
    expect((await calls(ana)).statusCode).toBe(200);
    // the owner's session from the test above, with two-step on
    const promoted = await api.request('PATCH', `${C}/members/${api.users.staff}`, { cookie: owner, body: { role: 'admin' } });
    expect(promoted.statusCode).toBe(204);
    const res = await calls(ana);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('two_factor_required');
    expect((await me(ana)).twoFactorRequired).toBe(true);
  });
});

describe('the setting', () => {
  it('takes required, optional or managers, and nothing else', () => {
    const base = { DATABASE_URL: 'postgres://a:b@localhost:5432/c', ATTENDRA_DATA_KEY: 'x'.repeat(44), BETTER_AUTH_SECRET: 's'.repeat(32) };
    expect(loadEnv({ ...base, ATTENDRA_TWO_FACTOR: 'managers' }).ATTENDRA_TWO_FACTOR).toBe('managers');
    expect(() => loadEnv({ ...base, ATTENDRA_TWO_FACTOR: 'admins' })).toThrow('ATTENDRA_TWO_FACTOR');
  });

  it('names the roles for each value', () => {
    expect(twoFactorRoles('required')).toEqual(['owner', 'admin', 'staff', 'viewer']);
    expect(twoFactorRoles(undefined)).toEqual(['owner', 'admin', 'staff', 'viewer']);
    expect(twoFactorRoles('managers')).toEqual(['owner', 'admin']);
    expect(twoFactorRoles('optional')).toEqual([]);
  });
});
