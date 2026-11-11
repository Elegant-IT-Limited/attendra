import { BUILT_IN_VOICES, DEMO_CLINIC, hasPreview, PREVIEW_VOICES, SETTINGS_LIMITS } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OTHER, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}/voice-sample`;
let api: Awaited<ReturnType<typeof startApi>>;
let owner: string;
let staff: string;
const sample = vi.fn(async (voice: string, text: string) => Buffer.from(`${voice}:${text.slice(0, 10)}`));

beforeAll(async () => {
  api = await startApi({ demoMode: false, voiceSamples: { sample } });
  owner = await api.signIn('omar@maple.example', true);
  staff = await api.signIn('ana@maple.example', true);
});
afterAll(() => api.close());

describe('hearing a voice before choosing it', () => {
  it('speaks the clinic\'s own greeting in a built-in voice, once per voice and greeting, with nothing in the audit log', async () => {
    const before = ((await api.t.owner.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number }).n;
    const res = await api.request('GET', `${C}?voice=cedar`, { cookie: owner });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['cache-control']).toBe('no-store'); // a changed greeting is never heard from an old copy
    expect(sample).toHaveBeenCalledWith('cedar', DEMO_CLINIC.greeting.slice(0, 300));
    await api.request('GET', `${C}?voice=cedar`, { cookie: staff }); // anyone who can read Settings
    expect(sample).toHaveBeenCalledTimes(1); // the second one came from the cache
    const after = ((await api.t.owner.execute(sql`select count(*)::int as n from audit_logs where action not like 'auth%'`)).rows[0] as { n: number }).n;
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
    const res = await api.request('GET', `${A}?assistantName=Nora`, { cookie: staff });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { voices: { id: string; label: string }[]; suggested: Record<string, string>; savedIsSuggested: boolean };
    expect(body.voices.map((v) => v.id)).toEqual([...PREVIEW_VOICES]);
    expect(body.voices.find((v) => v.id === 'marin')?.label).toBe('Marin (the default)');
    expect(body.suggested.en).toBe(`Thanks for calling ${DEMO_CLINIC.name}. I'm Nora, the clinic's AI assistant. How can I help you today?`);
    expect(body.suggested.es).toContain('Soy Nora');
    // the demo clinic's greeting is the one suggested for its name
    expect(body.savedIsSuggested).toBe(true);
    expect((await api.request('GET', A, { cookie: staff })).json().suggested.en).toBe(DEMO_CLINIC.greeting);
    // the setup page's limits are the ones Settings and the schema use (batch 1e: one source)
    expect(res.json().limits).toEqual(SETTINGS_LIMITS);
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

// Note 46: a location on Vapi hears ElevenLabs' own sample of each listed voice, fetched by the API once and kept.
describe('hearing a Vapi voice', () => {
  it('plays ElevenLabs\' sample of a listed voice, fetched once, and refuses any other address', async () => {
    const mp3 = Buffer.alloc(4000, 7);
    const fetched: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => { fetched.push(String(url)); return new Response(mp3, { status: 200 }); });
    try {
      const res = await api.request('GET', `${C}?voice=11labs:XrExE9yKIg1WjnnlVkGX`, { cookie: owner });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.rawPayload.length).toBe(4000);
      await api.request('GET', `${C}?voice=11labs:XrExE9yKIg1WjnnlVkGX`, { cookie: staff });
      expect(fetched).toEqual(['https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3']);
      // a voice we do not list, and one with no sample we know of
      expect((await api.request('GET', `${C}?voice=11labs:someone-else`, { cookie: owner })).statusCode).toBe(422);
      const none = await api.request('GET', `${C}?voice=11labs:iP95p4xoKVk53GoZ742B`, { cookie: owner });
      expect([none.statusCode, none.json().error]).toEqual([422, 'calls_only']);
      expect(sample).not.toHaveBeenCalledWith(expect.stringContaining('11labs'), expect.anything());
    } finally {
      spy.mockRestore();
    }
  });

  it('says so when the sample cannot be fetched', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 403 }));
    try {
      const res = await api.request('GET', `${C}?voice=11labs:cgSgspJ2msm6clMCkdW9`, { cookie: owner });
      expect([res.statusCode, res.json().error]).toEqual([422, 'no_sample']);
    } finally {
      spy.mockRestore();
    }
  });
});
