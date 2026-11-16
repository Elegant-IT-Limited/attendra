import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// Note 2026-11-16 (demo findings 3, item 3): renaming a kind of request in Fields and lists carries the new name to every
// request of that kind, in the save's transaction, audited with how many; other requests are untouched. Made-up data.
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let owner: string;
type Served = { id: string; details: Record<string, string> };
const search = async (q: string) => (await api.request('POST', `${C}/tasks/search`, { cookie: owner, body: { status: 'open', q } })).json().tasks as Served[];
const settings = async () => (await api.request('GET', `${C}/settings`, { cookie: owner })).json();
const fieldsBody = (s: Record<string, unknown>, requestTopics: unknown) => ({ customFields: s.customFields ?? [], providerFields: s.providerFields ?? [], requestFields: s.requestFields ?? [], requestTopics });
const renamedAudit = async () => (await api.t.owner.execute(sql`select counts from audit_logs where action = 'clinic.request_kind.renamed' order by id`)).rows as { counts: Record<string, number> }[];

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  owner = await api.signIn('omar@maple.example', true);
  const s = await settings();
  expect((await api.request('PUT', `${C}/settings/fields`, { cookie: owner, body: fieldsBody(s, [{ id: 'topic_board', name: 'Boarding booking' }, { id: 'topic_groom', name: 'Grooming' }]) })).statusCode).toBe(200);
  for (const [topic, reason] of [['Boarding booking', 'Three nights from Friday'], ['Boarding booking', 'Two nights over the holiday'], ['Grooming', 'A bath and nail trim']]) {
    expect((await api.request('POST', `${C}/tasks`, { cookie: owner, body: { type: 'callback', topic, reason } })).statusCode).toBe(201);
  }
});
afterAll(() => api.close());

describe('a renamed kind of request', () => {
  it('reaches every request of that kind from Fields and lists, audited, and leaves the others', async () => {
    const s = await settings();
    const res = await api.request('PUT', `${C}/settings/fields`, { cookie: owner, body: fieldsBody(s, [{ id: 'topic_board', name: 'Boarding stay' }, { id: 'topic_groom', name: 'Grooming' }]) });
    expect(res.statusCode).toBe(200);
    expect((await search('nights')).map((t) => t.details.topic).sort()).toEqual(['Boarding stay', 'Boarding stay']);
    expect((await search('nail trim')).map((t) => t.details.topic)).toEqual(['Grooming']);
    // the new name finds them; the old one no longer does
    expect(await search('Boarding stay')).toHaveLength(2);
    expect(await search('Boarding booking')).toHaveLength(0);
    expect((await renamedAudit()).at(-1)?.counts).toEqual({ kinds: 1, requests: 2 });
  });

  it('reaches them from a whole settings save too', async () => {
    const s = await settings();
    expect((await api.request('PUT', `${C}/settings`, { cookie: owner, body: { ...s, requestTopics: [{ id: 'topic_board', name: 'Boarding' }, { id: 'topic_groom', name: 'Grooming' }] } })).statusCode).toBe(200);
    expect((await search('nights')).map((t) => t.details.topic)).toEqual(['Boarding', 'Boarding']);
    expect((await renamedAudit()).at(-1)?.counts).toEqual({ kinds: 1, requests: 2 });
  });

  it('a save that renames nothing writes nothing to the requests', async () => {
    const before = (await renamedAudit()).length;
    const s = await settings();
    expect((await api.request('PUT', `${C}/settings/fields`, { cookie: owner, body: fieldsBody(s, s.requestTopics) })).statusCode).toBe(200);
    expect(await renamedAudit()).toHaveLength(before);
  });
});
