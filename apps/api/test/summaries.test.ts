import { DEMO_CLINIC } from '@attendra/core';
import { CallSummaryRepository, createPhiCipher } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'staff' | 'viewer', string>;

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  as = { staff: await api.signIn('ana@maple.example', true), viewer: await api.signIn('vic@maple.example', true) };
  // what the worker writes after the helper's refill call
  await new CallSummaryRepository(api.t.db, createPhiCipher(TEST_DATA_KEY)).save(DEMO_CLINIC.id, api.callId, {
    summary: 'The caller asked for a lisinopril refill. The assistant took the request for the care team.',
    intent: 'refill', sentiment: 'calm', needsReview: true, reviewReason: 'The caller mentioned running out today.', followUp: 'Call the patient back about the refill.',
  }, 'gpt-test');
});
afterAll(() => api.close());

describe('call summaries', () => {
  it('come with the call, inside the audited transcript view', async () => {
    const res = (await api.request('GET', `${C}/calls/${api.callId}`, { cookie: as.staff })).json();
    expect(res.summary).toMatchObject({ intent: 'refill', sentiment: 'calm', needsReview: true, followUp: 'Call the patient back about the refill.', model: 'gpt-test', reviewedAt: null });
    expect(res.summaryJob).toBeNull();
  });

  it('put codes, never text, in the call list, which a viewer can filter by review too', async () => {
    const list = await api.request('GET', `${C}/calls?review=needed`, { cookie: as.viewer });
    expect(list.json().calls).toEqual([expect.objectContaining({ id: api.callId, intent: 'refill', needsReview: true })]);
    expect(list.body).not.toContain('lisinopril');
    expect((await api.request('GET', `${C}/calls?review=maybe`, { cookie: as.staff })).statusCode).toBe(400);
  });

  it('give requests from the call their suggested next step', async () => {
    const tasks = (await api.request('GET', `${C}/tasks`, { cookie: as.staff })).json().tasks;
    expect(tasks.find((t: { callId: string }) => t.callId === api.callId).followUp).toBe('Call the patient back about the refill.');
  });

  it('are marked reviewed by staff, audited, and leave the filter; a viewer cannot, and another clinic cannot see them', async () => {
    expect((await api.request('POST', `${C}/calls/${api.callId}/review`, { cookie: as.viewer })).statusCode).toBe(403);
    expect((await api.request('POST', `/api/v1/clinics/${OTHER.id}/calls/${api.callId}/review`, { cookie: as.staff })).statusCode).toBe(404);
    expect((await api.request('POST', `${C}/calls/${api.callId}/review`, { cookie: as.staff })).statusCode).toBe(204);
    const call = (await api.request('GET', `${C}/calls/${api.callId}`, { cookie: as.staff })).json();
    expect(call.summary.reviewedAt).not.toBeNull();
    expect((await api.request('GET', `${C}/calls?review=needed`, { cookie: as.staff })).json().calls).toEqual([]);
    const rows = (await api.t.db.execute(sql`select actor from audit_logs where action = 'call.summary.reviewed' and entity_id = ${api.callId}`)).rows;
    expect(rows).toEqual([{ actor: `user:${api.users.staff}` }]);
  });

  it('a call with no summary says so, with no job when the worker has never run', async () => {
    const other = (await api.t.db.execute(sql`insert into calls (clinic_id, openai_session_id, ended_at, outcome) values (${DEMO_CLINIC.id}, 'live_no_summary', now(), 'info') returning id`)).rows[0] as { id: string };
    const res = (await api.request('GET', `${C}/calls/${other.id}`, { cookie: as.staff })).json();
    expect(res).toMatchObject({ summary: null, summaryJob: null });
    expect((await api.request('POST', `${C}/calls/${other.id}/review`, { cookie: as.staff })).statusCode).toBe(404);
  });
});
