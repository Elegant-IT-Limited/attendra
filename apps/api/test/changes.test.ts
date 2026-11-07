import { DEMO_CLINIC } from '@attendra/core';
import { saveClinic } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

/**
 * The change stream as a browser sees it (decision 10, batch 3): a person's own
 * invitations and roles reach them in or out of a clinic, and a browser that comes back
 * with Last-Event-ID is told what it missed and nothing more. Made-up people.
 */
const BRANCH = { ...DEMO_CLINIC, id: 'clinic_branch', name: 'Maple Street Branch', phoneNumbers: ['+13035550121'] };
let api: Awaited<ReturnType<typeof startApi>>;
let base: string;
let owner: string;
let ana: string;

beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional', changes: true });
  await saveClinic(api.t.db, 'org_demo', BRANCH);
  owner = await api.signIn('omar@maple.example');
  ana = await api.signIn('ana@maple.example');
  await api.app.listen(0, '127.0.0.1');
  base = (await api.app.getUrl()).replace('[::1]', '127.0.0.1');
}, 120_000);
afterAll(() => api.close());

interface Message { event: string; id: string | null; data: Record<string, unknown> }

/** Opens a stream and reads its messages as they come. */
async function open(path: string, cookie: string, lastEventId?: string) {
  const abort = new AbortController();
  const res = await fetch(`${base}${path}`, { headers: { cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal: abort.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queue: Message[] = [];
  const parse = (block: string): Message | null => {
    let event = 'message'; let id: string | null = null; let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    return data ? { event, id, data: JSON.parse(data) } : null;
  };
  /** The next message of this kind, within `ms`. */
  const next = async (event: string, ms = 3000): Promise<Message> => {
    const until = Date.now() + ms;
    for (;;) {
      const i = queue.findIndex((m) => m.event === event);
      if (i >= 0) return queue.splice(i, 1)[0]!;
      if (Date.now() > until) throw new Error(`no ${event} within ${ms} ms`);
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), until - Date.now()))]);
      if (!chunk || chunk.done) continue;
      buffer += decoder.decode(chunk.value);
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) { const m = parse(buffer.slice(0, cut)); buffer = buffer.slice(cut + 2); if (m) queue.push(m); }
    }
  };
  return { status: res.status, type: res.headers.get('content-type'), next, close: () => abort.abort() };
}

describe('a person\'s own changes', () => {
  it('outside any clinic: an invitation to them arrives within seconds, and never someone else\'s', async () => {
    const mine = await open('/api/v1/me/changes', ana);
    expect(mine.type).toMatch(/text\/event-stream/);
    expect((await mine.next('ready')).data).toEqual({ missed: [] });
    const owners = await open('/api/v1/me/changes', owner);
    await owners.next('ready');
    const started = Date.now();
    expect((await api.request('POST', `/api/v1/clinics/${BRANCH.id}/members`, { cookie: owner, body: { email: 'ana@maple.example', role: 'viewer' } })).statusCode).toBe(201);
    const change = await mine.next('change');
    expect(change.data).toEqual({ topics: ['me'] });
    expect(Date.now() - started).toBeLessThan(3000);
    // the owner who sent it hears nothing about themselves
    await expect(owners.next('change', 600)).rejects.toThrow(/no change/);
    mine.close(); owners.close();
  });

  it('inside a clinic: the same stream carries the person\'s role changes with the team\'s', async () => {
    const tab = await open(`/api/v1/clinics/${DEMO_CLINIC.id}/changes`, ana);
    await tab.next('ready');
    const id = (await api.request('GET', `/api/v1/clinics/${DEMO_CLINIC.id}/members`, { cookie: owner })).json().members.find((m: { email: string }) => m.email === 'ana@maple.example').userId;
    expect((await api.request('PATCH', `/api/v1/clinics/${DEMO_CLINIC.id}/members/${id}`, { cookie: owner, body: { role: 'viewer' } })).statusCode).toBeLessThan(300);
    const topics = (await tab.next('change')).data.topics as string[];
    expect(topics.sort()).toEqual(['me', 'team']);
    tab.close();
  });

  it('needs a sign-in', async () => {
    expect((await api.request('GET', '/api/v1/me/changes')).statusCode).toBe(401);
  });
});

describe('coming back', () => {
  it('with the last id: told what was missed, and nothing when nothing was', async () => {
    const first = await open(`/api/v1/clinics/${DEMO_CLINIC.id}/changes`, owner);
    const ready = await first.next('ready');
    first.close();
    // while away: a note on a request
    await api.request('POST', `/api/v1/clinics/${DEMO_CLINIC.id}/tasks/${api.taskId}/notes`, { cookie: owner, body: { body: 'called the pharmacy' } });
    await new Promise((r) => setTimeout(r, 100));
    const back = await open(`/api/v1/clinics/${DEMO_CLINIC.id}/changes`, owner, ready.id!);
    const missed = await back.next('ready');
    expect(missed.data).toEqual({ missed: ['requests'] });
    back.close();
    // up to date: a quiet reconnect
    const again = await open(`/api/v1/clinics/${DEMO_CLINIC.id}/changes`, owner, missed.id!);
    expect((await again.next('ready')).data).toEqual({ missed: [] });
    again.close();
  });

  it('with an id from before a restart: told everything may have changed', async () => {
    const back = await open(`/api/v1/clinics/${DEMO_CLINIC.id}/changes`, owner, '0badc0de.12');
    expect((await back.next('ready')).data).toEqual({ missed: '*' });
    back.close();
  });

  it('every message has an id to come back with', async () => {
    const tab = await open(`/api/v1/clinics/${DEMO_CLINIC.id}/changes`, owner);
    expect((await tab.next('ready')).id).toMatch(/^[0-9a-f]{8}\.\d+$/);
    await api.request('POST', `/api/v1/clinics/${DEMO_CLINIC.id}/tasks/${api.taskId}/notes`, { cookie: owner, body: { body: 'left a message' } });
    expect((await tab.next('change')).id).toMatch(/^[0-9a-f]{8}\.\d+$/);
    tab.close();
  });
});
