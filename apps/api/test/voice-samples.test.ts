import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OTHER, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}/voice-sample`;
let api: Awaited<ReturnType<typeof startApi>>;
let owner: string;
let viewer: string;
const sample = vi.fn(async (voice: string, text: string) => Buffer.from(`${voice}:${text.slice(0, 10)}`));

beforeAll(async () => {
  api = await startApi({ demoMode: false, voiceSamples: { sample } });
  owner = await api.signIn('omar@maple.example', true);
  viewer = await api.signIn('vic@maple.example', true);
});
afterAll(() => api.close());

describe('hearing a voice before choosing it', () => {
  it('speaks the clinic\'s own greeting in a built-in voice, once per voice and greeting, with nothing in the audit log', async () => {
    const before = ((await api.t.db.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number }).n;
    const res = await api.request('GET', `${C}?voice=cedar`, { cookie: owner });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(sample).toHaveBeenCalledWith('cedar', DEMO_CLINIC.greeting.slice(0, 300));
    await api.request('GET', `${C}?voice=cedar`, { cookie: viewer }); // anyone who can read Settings
    expect(sample).toHaveBeenCalledTimes(1); // the second one came from the cache
    const after = ((await api.t.db.execute(sql`select count(*)::int as n from audit_logs where action not like 'auth%'`)).rows[0] as { n: number }).n;
    expect(after).toBeLessThanOrEqual(before + 2); // sign-ins at most, no sample rows
  });

  it('refuses a voice that is not built in, another clinic, and says when a voice has no sample', async () => {
    expect((await api.request('GET', `${C}?voice=nobody`, { cookie: owner })).statusCode).toBe(422);
    expect((await api.request('GET', `/api/v1/clinics/${OTHER.id}/voice-sample?voice=cedar`, { cookie: owner })).statusCode).toBe(404);
    sample.mockRejectedValueOnce(new Error('unsupported voice'));
    const res = await api.request('GET', `${C}?voice=tempo`, { cookie: owner });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('no_sample');
  });
});

describe('without a voice sampler', () => {
  it('says samples are off', async () => {
    const off = await startApi({ demoMode: false });
    const cookie = await off.signIn('omar@maple.example', true);
    const res = await off.request('GET', `${C}?voice=cedar`, { cookie });
    expect(res.statusCode).toBe(503);
    await off.close();
  });
});
