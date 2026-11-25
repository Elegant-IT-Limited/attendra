// SPDX-License-Identifier: AGPL-3.0-only
import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// RPT-batch-11-07-3-2: one search in the Cmd-K palette wrote two tasks.searched audit rows, because it asked for open
// requests and done ones in two searches. One search for both, open first, writes one row. Made-up data.
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
const searched = async () => ((await api.t.owner.execute(sql`select entity_id from audit_logs where action = 'tasks.searched' order by id`)).rows as { entity_id: string }[]).map((r) => r.entity_id);

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  staff = await api.signIn('ana@maple.example', true);
});
afterAll(() => api.close());

describe('RPT-batch-11-07-3-2: one request search, one audit row', () => {
  it('RPT-batch-11-07-3-2: a search of open and done requests together answers both, open first, and writes one tasks.searched row', async () => {
    const made = async (medication: string) => (await api.request('POST', `${C}/tasks`, { cookie: staff, body: { type: 'refill', medication, callbackNumber: '(303) 555-0162' } })).json() as { id: string; number: number };
    const open = await made('Zylkene 75 mg');
    const done = await made('Zylkene 225 mg');
    expect((await api.request('POST', `${C}/tasks/${done.id}/done`, { cookie: staff, body: { outcome: 'not_needed' } })).statusCode).toBeLessThan(300);
    const before = await searched();

    const res = await api.request('POST', `${C}/tasks/search`, { cookie: staff, body: { q: 'Zylkene', status: 'all' } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { tasks: { id: string; status: string }[] }).tasks.map((t) => [t.id, t.status]);
    expect(ids).toEqual([[open.id, 'open'], [done.id, 'done']]);
    // one row for the one search, with how many matched, never the words
    expect((await searched()).slice(before.length)).toEqual(['matches:2']);
  });

  it('RPT-batch-11-07-3-2: a search of only open, or only done, requests is as before', async () => {
    const before = await searched();
    const open = (await api.request('POST', `${C}/tasks/search`, { cookie: staff, body: { q: 'Zylkene' } })).json() as { tasks: { status: string }[] };
    expect(open.tasks.map((t) => t.status)).toEqual(['open']);
    const done = (await api.request('POST', `${C}/tasks/search`, { cookie: staff, body: { q: 'Zylkene', status: 'done' } })).json() as { tasks: { status: string }[] };
    expect(done.tasks.map((t) => t.status)).toEqual(['done']);
    expect((await searched()).slice(before.length)).toEqual(['matches:1', 'matches:1']);
  });
});
