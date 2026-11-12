import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// Note 52 C9: a request added at the desk wrote a second audit row, "Changed a request's urgency or due day", though
// nothing was changed; and the Record column read a bare "Request" on every row but the one that created it.
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let owner: string;
beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional' });
  owner = await api.signIn('omar@maple.example');
});
afterAll(() => api.close());

const rowsFor = async (taskId: string) =>
  ((await api.t.owner.execute(sql`select action from audit_logs where entity = 'task' and entity_id = ${taskId} order by id`)).rows as { action: string }[]).map((r) => r.action);
const add = async (body: Record<string, unknown>) => {
  const res = await api.request('POST', `${C}/tasks`, { cookie: owner, body: { type: 'refill', reason: 'Needs a refill of the heart pill before Friday', ...body } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; number: number };
};

describe('the audit log for a request', () => {
  it('records adding a request once, with no change row when it is added as not urgent and with no due day', async () => {
    // what New request sends for a request nobody marked: urgent false, no due day
    const { id } = await add({ urgent: false, dueOn: null });
    expect(await rowsFor(id)).toEqual(['task.created.refill']);
  });

  it('records a real change only: marked urgent when added is one change, the same choice again is none', async () => {
    const { id } = await add({ urgent: true });
    expect(await rowsFor(id)).toEqual(['task.created.refill', 'task.planned']);
    const plan = (body: unknown) => api.request('POST', `${C}/tasks/${id}/plan`, { cookie: owner, body });
    expect((await plan({ urgent: true })).statusCode).toBe(204);
    expect((await plan({ urgent: true, dueOn: null })).statusCode).toBe(204);
    expect(await rowsFor(id)).toEqual(['task.created.refill', 'task.planned']);
    expect((await plan({ dueOn: '2026-12-01' })).statusCode).toBe(204);
    expect(await rowsFor(id)).toEqual(['task.created.refill', 'task.planned', 'task.planned']);
    // and the change itself is kept
    const shown = ((await api.request('GET', `${C}/tasks`, { cookie: owner })).json().tasks as { id: string; urgent: boolean; dueOn: string | null }[]).find((t) => t.id === id);
    expect(shown).toMatchObject({ urgent: true, dueOn: '2026-12-01' });
  });

  it('names the request by its number on every row about it, not only the one that created it', async () => {
    const { id, number } = await add({ urgent: true });
    // a note's row stores no number of its own: the log reads it from the request
    expect((await api.request('POST', `${C}/tasks/${id}/notes`, { cookie: owner, body: { body: 'Called the pharmacy' } })).statusCode).toBeLessThan(300);
    const entries = (await api.request('GET', `${C}/audit?limit=100`, { cookie: owner })).json().entries as { action: string; entity: string; entityId: string | null; counts: Record<string, number> | null }[];
    const mine = entries.filter((e) => e.entity === 'task' && e.entityId === id);
    expect(mine.map((e) => e.action).sort()).toEqual(['task.created.refill', 'task.note.added', 'task.planned'].sort());
    for (const e of mine) expect(e.counts?.number, e.action).toBe(number);
  });
});
