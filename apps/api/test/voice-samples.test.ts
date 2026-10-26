import { BUILT_IN_VOICES, DEMO_CLINIC, hasPreview, PREVIEW_VOICES } from '@attendra/core';
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
    expect(res.headers['cache-control']).toBe('no-store'); // a changed greeting is never heard from an old copy
    expect(sample).toHaveBeenCalledWith('cedar', DEMO_CLINIC.greeting.slice(0, 300));
    await api.request('GET', `${C}?voice=cedar`, { cookie: viewer }); // anyone who can read Settings
    expect(sample).toHaveBeenCalledTimes(1); // the second one came from the cache
    const after = ((await api.t.db.execute(sql`select count(*)::int as n from audit_logs where action not like 'auth%'`)).rows[0] as { n: number }).n;
    expect(after).toBeLessThanOrEqual(before + 2); // sign-ins at most, no sample rows
  });

  it('refuses a voice that is not built in, another clinic, and says when a voice has no sample', async () => {
    expect((await api.request('GET', `${C}?voice=nobody`, { cookie: owner })).statusCode).toBe(422);
    expect((await api.request('GET', `/api/v1/clinics/${OTHER.id}/voice-sample?voice=cedar`, { cookie: owner })).statusCode).toBe(404);
    sample.mockRejectedValueOnce(new Error('model unavailable'));
    const res = await api.request('GET', `${C}?voice=ash`, { cookie: owner });
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

describe('voices only the Live model has', () => {
  it('say they are heard in a test call, without asking any model', async () => {
    sample.mockClear();
    const res = await api.request('GET', `${C}?voice=tempo`, { cookie: owner });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('calls_only');
    expect(sample).not.toHaveBeenCalled();
  });

  it('the preview list is the speech model\'s voices, all of them phone voices', () => {
    expect(PREVIEW_VOICES.every((v) => (BUILT_IN_VOICES as readonly string[]).includes(v))).toBe(true);
    expect(hasPreview('marin') && !hasPreview('tempo')).toBe(true);
  });
});

describe('naming the assistant from a setup page', () => {
  const A = `/api/v1/clinics/${DEMO_CLINIC.id}/settings/assistant`;
  const S = `/api/v1/clinics/${DEMO_CLINIC.id}/settings`;
  it('offers the voices with a sample, and the greeting for a name, which a stock greeting follows', async () => {
    const res = await api.request('GET', `${A}?assistantName=Nora`, { cookie: viewer });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { voices: { id: string; label: string }[]; suggested: Record<string, string>; savedIsSuggested: boolean };
    expect(body.voices.map((v) => v.id)).toEqual([...PREVIEW_VOICES]);
    expect(body.voices.find((v) => v.id === 'marin')?.label).toBe('Marin (the default)');
    expect(body.suggested.en).toBe(`Thanks for calling ${DEMO_CLINIC.name}. I'm Nora, the clinic's AI assistant. How can I help you today?`);
    expect(body.suggested.es).toContain('Soy Nora');
    // the demo clinic's greeting is the one suggested for its name
    expect(body.savedIsSuggested).toBe(true);
    expect((await api.request('GET', A, { cookie: viewer })).json().suggested.en).toBe(DEMO_CLINIC.greeting);
  });

  it('a greeting the clinic wrote is kept; a name that is not one word and another clinic are refused', async () => {
    const current = (await api.request('GET', S, { cookie: owner })).json() as Record<string, unknown>;
    const own = 'Hello, Maple Street here. You are speaking with our AI assistant. What can we do for you?';
    expect((await api.request('PUT', S, { cookie: owner, body: { ...current, greeting: own } })).statusCode).toBe(200);
    expect((await api.request('GET', A, { cookie: owner })).json()).toMatchObject({ savedIsSuggested: false });
    expect((await api.request('GET', `${A}?assistantName=${encodeURIComponent('Maya 2')}`, { cookie: owner })).statusCode).toBe(422);
    expect((await api.request('GET', `/api/v1/clinics/${OTHER.id}/settings/assistant`, { cookie: owner })).statusCode).toBe(404);
  });
});
