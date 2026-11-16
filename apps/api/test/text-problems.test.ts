import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// Note 2026-11-16 (demo findings 3, item 4): a refill's text failed a few seconds after its panel closed, and nobody saw
// it. Each request carries its latest text when it was not sent, and the dashboard reads the recent ones from one
// route, with the request's number and type and the text's state only. Made-up data.
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
let refill: { id: string; number: number };
let other: { id: string; number: number };
const text = async (taskId: string, o: { template: string; status: string; reason?: string; code?: string; minutesAgo: number }) => {
  await api.t.owner.execute(sql`insert into sms_messages (clinic_id, template, to_hash, status, idempotency_key, task_id, failure_reason, error_code, created_at)
    values (${DEMO_CLINIC.id}, ${o.template}, 'h', ${o.status}, ${`k-${Math.random()}`}, ${taskId}, ${o.reason ?? null}, ${o.code ?? null}, now() - make_interval(mins => ${o.minutesAgo}))`);
};
const problems = async () => (await api.request('GET', `${C}/tasks/text-problems`, { cookie: staff })).json().problems as { taskId: string; number: number; type: string; taskStatus: string; status: string; failureReason: string | null; errorCode: string | null }[];
const rowOf = async (id: string) => ((await api.request('POST', `${C}/tasks/search`, { cookie: staff, body: { status: 'open', q: '' } })).json().tasks as { id: string; textProblem: unknown }[]).find((t) => t.id === id);

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  staff = await api.signIn('ana@maple.example', true);
  const made = async (reason: string) => (await api.request('POST', `${C}/tasks`, { cookie: staff, body: { type: 'refill', medication: 'Carprofen 75 mg', reason, callbackNumber: '(303) 555-0161' } })).json() as { id: string; number: number };
  refill = await made('Ready to pick up this week');
  other = await made('A second refill');
});
afterAll(() => api.close());

describe('a text about a request that was not sent', () => {
  it('is on the request and in the recent list, by number, type and code only', async () => {
    await text(refill.id, { template: 'request_ready', status: 'failed', code: '30006', minutesAgo: 2 });
    expect((await rowOf(refill.id))?.textProblem).toMatchObject({ status: 'failed', failureReason: null, errorCode: '30006' });
    const list = await problems();
    expect(list).toEqual([expect.objectContaining({ taskId: refill.id, number: refill.number, type: 'refill', taskStatus: 'open', status: 'failed', errorCode: '30006' })]);
    // nothing about the patient or the words of the text
    expect(JSON.stringify(list)).not.toMatch(/Carprofen|555-?0161|pick up this week/i);
  });

  it('a later text of the same kind that went clears it; one refused before the carrier counts too', async () => {
    await text(refill.id, { template: 'request_ready', status: 'sent', minutesAgo: 1 });
    expect((await rowOf(refill.id))?.textProblem).toBeNull();
    await text(other.id, { template: 'refill_sent', status: 'not_sent', reason: 'not_textable', minutesAgo: 1 });
    expect((await problems()).map((p) => [p.taskId, p.failureReason])).toEqual([[other.id, 'not_textable']]);
  });

  it('only the last three days, and only for people who read requests', async () => {
    await text(refill.id, { template: 'refill_not_approved', status: 'undelivered', code: '30005', minutesAgo: 4 * 24 * 60 });
    expect((await problems()).some((p) => p.status === 'undelivered')).toBe(false);
    const viewer = await api.signIn('vic@maple.example', true);
    expect((await api.request('GET', `${C}/tasks/text-problems`, { cookie: viewer })).statusCode).toBe(403);
  });
});
