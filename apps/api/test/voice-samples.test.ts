import { BUILT_IN_VOICES, DEMO_CLINIC } from '@attendra/core';
import { liveSample, TTS_VOICES } from '../src/voice-samples/samplers';
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

describe('voices only the Live model has', () => {
  const fakeLive = (script: (send: (e: object) => void) => void, speaksFirst = true) => {
    const handlers: Record<string, ((x: never) => void)[]> = {};
    const sent: { type: string; session?: { audio?: { output?: { voice?: string } }; input?: unknown[]; store?: boolean } }[] = [];
    const socket = {
      // like OpenAI: a client-delegation session refuses response.create; the model speaks from its instructions,
      // or after speakable commentary
      send: (e: never) => {
        sent.push(e);
        const type = (e as { type: string }).type;
        if (type === 'session.start') queueMicrotask(() => { emit({ type: 'session.started' }); if (speaksFirst) script(emit); });
        if (type === 'response.create') emit({ type: 'error', error: { code: 'invalid_request_error', message: 'response.create requires a session with Responses delegation.' } });
        if (type === 'session.commentary.append') script(emit);
      },
      on: (name: string, h: (x: never) => void) => { (handlers[name] ??= []).push(h); },
      close: vi.fn(),
    };
    const emit = (e: object) => { for (const h of handlers.event ?? []) h(e as never); };
    return { socket, sent };
  };

  it('reads the greeting in the voice over a Live WebSocket and answers a WAV, storing nothing', async () => {
    const pcm = Buffer.alloc(480, 1);
    const { socket, sent } = fakeLive((emit) => { emit({ type: 'session.output_audio.delta', delta: pcm.toString('base64') }); emit({ type: 'session.output_audio.delta', delta: pcm.toString('base64') }); });
    const audio = await liveSample(() => socket, 'gpt-live-1', 'tempo', 'Thanks for calling.', { quietMs: 10 });
    expect(audio.subarray(0, 4).toString()).toBe('RIFF');
    expect(audio.length).toBe(44 + 960);
    expect(sent[0]).toMatchObject({ type: 'session.start', session: { store: false, audio: { output: { voice: 'tempo' } }, instructions: expect.stringContaining('Start with exactly this greeting: "Thanks for calling."') } });
    // never response.create, which a client-delegation session refuses; no nudge once it speaks
    expect(sent.map((e) => e.type)).toEqual(['session.start']);
    expect(socket.close).toHaveBeenCalled();
  });

  it('nudges once with speakable commentary when the model has not started', async () => {
    const pcm = Buffer.alloc(240, 2);
    const { socket, sent } = fakeLive((emit) => emit({ type: 'session.output_audio.delta', delta: pcm.toString('base64') }), false);
    const audio = await liveSample(() => socket, 'gpt-live-1', 'willow', 'Hello.', { quietMs: 10, nudgeMs: 10 });
    expect(audio.length).toBe(44 + 240);
    expect(sent.map((e) => e.type)).toEqual(['session.start', 'session.commentary.append']);
  });

  it('fails cleanly on an error or no audio, so Settings says to try again', async () => {
    await expect(liveSample(() => fakeLive((emit) => emit({ type: 'error', error: { code: 'invalid_voice' } })).socket, 'gpt-live-1', 'tempo', 'Hi.')).rejects.toThrow('invalid_voice');
    await expect(liveSample(() => fakeLive(() => {}, false).socket, 'gpt-live-1', 'tempo', 'Hi.', { timeoutMs: 40, nudgeMs: 10 })).rejects.toThrow('timed out');
  });

  it('uses the speech model for the voices it has and the Live model for the rest', async () => {
    expect([...TTS_VOICES].every((v) => (BUILT_IN_VOICES as readonly string[]).includes(v))).toBe(true);
    expect(TTS_VOICES.has('marin') && !TTS_VOICES.has('tempo')).toBe(true);
  });
});
