import { DEMO_CLINIC } from '@attendra/core';
import { addMembership } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LiveActionResult, VoiceClient } from '../src/http/tokens';
import { ORIGIN, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
let admin: string;

// a call that goes on and on: a heartbeat every 50 ms, never an end
const endless = () => {
  let t: NodeJS.Timeout;
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode('event: snapshot\ndata: {"type":"snapshot"}\n\n')); t = setInterval(() => c.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 50); },
    cancel() { clearInterval(t); },
  });
};
const done: LiveActionResult = { ok: true, repeat: false };
const voice = {
  browserCalls: false, simulatedCalls: false, startTestCall: vi.fn(), endTestCall: vi.fn(), startSimulatedCall: vi.fn(),
  liveCalls: vi.fn(async () => []), liveStream: vi.fn(async () => endless()),
  coach: vi.fn(async () => done), takeOver: vi.fn(async () => done), endCall: vi.fn(async () => done),
} satisfies VoiceClient;
const watch = (cookie: string) => api.app.getHttpAdapter().getInstance().inject({ method: 'GET', url: `${C}/calls/${api.callId}/live`, headers: { cookie, origin: ORIGIN } });

beforeAll(async () => {
  api = await startApi({ demoMode: false, voice, liveStream: { maxMs: 3000, recheckMs: 100 } });
  staff = await api.signIn('ana@maple.example', true);
  admin = await api.signIn('olga@maple.example', true);
});
afterAll(() => api.close());

describe('a live stream', () => {
  it('ends at its time limit, however long the call goes on', async () => {
    const started = Date.now();
    const res = await watch(staff);
    expect(res.statusCode).toBe(200);
    // at the 3 second limit, not never: the bound above it is wide, so a busy machine does not fail it
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('ends soon after the watcher may no longer read calls', async () => {
    const started = Date.now();
    const res = watch(admin);
    setTimeout(() => void addMembership(api.t.db, 'org_demo', api.users.admin, 'viewer'), 200);
    expect((await res).statusCode).toBe(200);
    // well before the 3 second limit: the re-check ended it, not the clock
    expect(Date.now() - started).toBeLessThan(2500);
    await addMembership(api.t.db, 'org_demo', api.users.admin, 'admin');
  });
});
