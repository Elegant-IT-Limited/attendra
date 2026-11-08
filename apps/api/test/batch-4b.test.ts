import { DEMO_CLINIC, EMERGENCY_RESULTS } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresTaskQueue } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

// Batch 4b: reopening a request and its history (REQ-3), the Calls list filtered by how an emergency ended (CALL-2), and
// the two call markers on the call page (CALL-3). Made-up demo data only.
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const cipher = createPhiCipher(TEST_DATA_KEY);
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'staff' | 'viewer', string>;
let request: string;
let emergencyCall: string;

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  as = {
    owner: await api.signIn('omar@maple.example', true),
    staff: await api.signIn('ana@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true),
  };
  ({ id: request } = await new PostgresTaskQueue(api.t.db, cipher).create(DEMO_CLINIC.id, { type: 'callback', callId: null, patientId: null, idempotencyKey: 'b4b-reopen', details: { reason: 'call back about Biscuit' } }));
  const calls = new CallRepository(api.t.db, cipher);
  emergencyCall = await calls.open(DEMO_CLINIC.id, 'rtc_b4b_1', '+15555550161');
  await calls.close(DEMO_CLINIC.id, emergencyCall, { reason: 'silent_start', voiceSeconds: 40, outcome: 'emergency', emergency: true, emergencyResult: 'hospital_texted', quality: { firstAudioMs: 900, stalls: 0, answerTimeouts: 0, maxGapMs: 1800, repeatedQuestions: 2 } });
});
afterAll(() => api.close());

describe('reopening a request (REQ-3)', () => {
  it('opens a closed request again for anyone who works requests, audited, and says so in its history by name and role', async () => {
    expect((await api.request('POST', `${C}/tasks/${request}/done`, { cookie: as.staff, body: { outcome: 'called_back' } })).statusCode).toBe(204);
    // a viewer works no requests
    expect((await api.request('POST', `${C}/tasks/${request}/reopen`, { cookie: as.viewer })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/tasks/${request}/reopen`, { cookie: as.staff })).statusCode).toBe(204);
    // already open: a 409 that says so
    const again = await api.request('POST', `${C}/tasks/${request}/reopen`, { cookie: as.staff });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'task_open' });
    expect((await api.request('POST', `${C}/tasks/not-a-uuid/reopen`, { cookie: as.staff })).statusCode).toBe(404);
    const listed = (await api.request('GET', `${C}/tasks?status=open`, { cookie: as.staff })).json().tasks as { id: string; status: string; outcome: string | null; doneAt: string | null }[];
    expect(listed.find((t) => t.id === request)).toMatchObject({ status: 'open', outcome: null, doneAt: null });
    const audited = (await api.t.owner.execute(sql`select actor from audit_logs where action = 'task.reopened' and entity_id = ${request}`)).rows;
    expect(audited).toHaveLength(1);
    const history = (await api.request('GET', `${C}/tasks/${request}/history`, { cookie: as.staff })).json();
    expect(history.events.map((e: { action: string; by: unknown }) => [e.action, e.by])).toEqual([
      ['task.created.callback', { kind: 'assistant' }],
      ['task.done', { kind: 'staff', name: 'Ana Front', role: 'staff' }],
      ['task.reopened', { kind: 'staff', name: 'Ana Front', role: 'staff' }],
    ]);
  });

  it('keeps the history from a viewer and from another clinic', async () => {
    expect((await api.request('GET', `${C}/tasks/${request}/history`, { cookie: as.viewer })).statusCode).toBe(403);
    // another clinic's address never finds this clinic's request
    expect([403, 404]).toContain((await api.request('GET', `/api/v1/clinics/${OTHER.id}/tasks/${request}/history`, { cookie: as.owner })).statusCode);
    expect((await api.request('GET', `${C}/tasks/00000000-0000-4000-8000-000000000000/history`, { cookie: as.staff })).statusCode).toBe(404);
  });
});

describe('the Calls list and call page (CALL-2, CALL-3)', () => {
  it('lists how an emergency ended, and filters by it on the server, list and search alike', async () => {
    const all = (await api.request('GET', `${C}/calls`, { cookie: as.staff })).json().calls as { id: string; emergencyResult: string | null }[];
    expect(all.find((c) => c.id === emergencyCall)!.emergencyResult).toBe('hospital_texted');
    const only = (await api.request('GET', `${C}/calls?emergencyResult=hospital_texted`, { cookie: as.staff })).json().calls as { id: string }[];
    expect(only.map((c) => c.id)).toEqual([emergencyCall]);
    expect((await api.request('GET', `${C}/calls?emergencyResult=transferred`, { cookie: as.staff })).json().calls).toEqual([]);
    // a viewer filters too: no patient data in it
    expect((await api.request('GET', `${C}/calls?emergencyResult=hospital_texted`, { cookie: as.viewer })).json().calls.map((c: { id: string }) => c.id)).toEqual([emergencyCall]);
    expect((await api.request('GET', `${C}/calls?emergencyResult=maybe`, { cookie: as.staff })).statusCode).toBe(422);
    const found = (await api.request('POST', `${C}/calls/search`, { cookie: as.staff, body: { query: '0161', emergencyResult: 'hospital_texted' } })).json().calls as { id: string }[];
    expect(found.map((c) => c.id)).toEqual([emergencyCall]);
    expect((await api.request('POST', `${C}/calls/search`, { cookie: as.staff, body: { query: '0161', emergencyResult: 'cleared' } })).json().calls).toEqual([]);
  });

  it('every emergency result and every outcome is a filter the API takes', async () => {
    for (const r of EMERGENCY_RESULTS) expect((await api.request('GET', `${C}/calls?emergencyResult=${r}`, { cookie: as.staff })).statusCode).toBe(200);
    for (const o of ['no_audio', 'abandoned', 'emergency']) expect((await api.request('GET', `${C}/calls?outcome=${o}`, { cookie: as.staff })).statusCode).toBe(200);
  });

  it('the call page carries the longest wait and the questions asked again', async () => {
    const call = (await api.request('GET', `${C}/calls/${emergencyCall}`, { cookie: as.staff })).json();
    expect(call).toMatchObject({ maxGapMs: 1800, repeatedQuestions: 2, closeReason: 'silent_start', emergencyResult: 'hospital_texted' });
    // a call from before v55 says nothing about either
    expect((await api.request('GET', `${C}/calls/${api.callId}`, { cookie: as.staff })).json()).toMatchObject({ maxGapMs: null, repeatedQuestions: null });
  });
});
