import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { authenticateApiKey, clinicForNumber } from '@attendra/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

const TOKEN = 'p'.repeat(40);
const auth = `Bearer ${TOKEN}`;
const P = '/api/v1/provisioning';
const C = DEMO_CLINIC.id;
const TABLES = [
  'api_keys', 'appointments', 'audit_logs', 'call_actions', 'call_segments', 'call_summaries', 'calls', 'knowledge_chunks', 'knowledge_documents',
  'patients', 'phone_numbers', 'sms_messages', 'sms_opt_outs', 'task_notes', 'tasks', 'webhook_attempts', 'webhook_endpoints', 'webhook_events',
];
let api: Awaited<ReturnType<typeof startApi>>;
let owner: string;

beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional', provisioningToken: TOKEN });
  owner = await api.signIn('omar@maple.example', true);
});
afterAll(() => api.close());

/** Rows each table holds for a clinic, read the way the clinic's own requests read them. */
async function rowsOf(clinicId: string, on = api) {
  return on.t.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    const counts: Record<string, number> = {};
    for (const t of TABLES) counts[t] = Number(((await tx.execute(sql`select count(*)::int as n from ${sql.identifier(t)} where clinic_id = ${clinicId}`)).rows[0] as { n: number }).n);
    return counts;
  });
}
const close = (closed: boolean, clinicId = C, on = api) => on.request('PUT', `${P}/clinics/${clinicId}/closed`, { body: { closed }, authorization: auth });
const purge = (clinicId = C, on = api) => on.request('DELETE', `${P}/clinics/${clinicId}`, { authorization: auth });

describe('closing a clinic, and deleting it 30 days later', () => {
  let key: string;

  it('a closed clinic leaves the dashboard, answers no calls and its keys stop; opened again, it is back', async () => {
    key = (await api.request('POST', `/api/v1/clinics/${C}/api-keys`, { cookie: owner, body: { name: 'Front desk agent', scopes: ['schedule:read'], expiresInDays: 30 } })).json().key;
    expect(await authenticateApiKey(api.t.db, key)).not.toBeNull();
    expect((await api.request('PUT', `${P}/clinics/${C}/numbers/${encodeURIComponent('+13035550177')}`, { authorization: auth })).statusCode).toBe(204);
    expect(await clinicForNumber(api.t.db, '+13035550177')).not.toBeNull();

    expect((await close(true)).statusCode).toBe(204);
    expect((await api.request('GET', '/api/v1/me', { cookie: owner })).json().clinics).toEqual([]);
    expect((await api.request('GET', `/api/v1/clinics/${C}/settings`, { cookie: owner })).statusCode).not.toBe(200);
    expect(await clinicForNumber(api.t.db, '+13035550177')).toBeNull();
    expect(await authenticateApiKey(api.t.db, key)).toBeNull();
    expect((await close(true, 'clinic_none')).statusCode).toBe(404);

    expect((await close(false)).statusCode).toBe(204);
    expect((await api.request('GET', '/api/v1/me', { cookie: owner })).json().clinics).toEqual([expect.objectContaining({ id: C })]);
    expect((await api.request('GET', `/api/v1/clinics/${C}/settings`, { cookie: owner })).statusCode).toBe(200);
    // its number comes back only when the hosting layer points it again; a revoked key stays revoked
    expect(await clinicForNumber(api.t.db, '+13035550177')).toBeNull();
    expect(await authenticateApiKey(api.t.db, key)).toBeNull();
  });

  it('is never deleted while open or within 30 days of closing; after that, every row of the clinic goes and nothing of another', async () => {
    // a clock of its own, so a visit can be booked on a real slot
    const now = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);
    const c = await startApi({ demoMode: false, twoFactor: 'optional', provisioningToken: TOKEN, now: () => now });
    try {
      const cookie = await c.signIn('omar@maple.example', true);
      const S = `/api/v1/clinics/${C}`;
      const slot = (await c.request('GET', `${S}/appointments/slots?visitTypeId=vt_sick&providerId=prov_okafor&from=2026-10-06&days=1`, { cookie })).json().slots[0];
      const booked = await c.request('POST', `${S}/appointments`, { cookie, body: { patientId: c.patientIds.maria, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: slot.startsAt, idempotencyKey: 'close-visit-1' } });
      expect(booked.statusCode, booked.body).toBe(201);
      expect((await c.request('POST', `${S}/tasks/${c.taskId}/notes`, { cookie, body: { body: 'Called back.' } })).statusCode).toBeLessThan(300);
      expect((await c.request('POST', `${S}/api-keys`, { cookie, body: { name: 'Agent', scopes: ['schedule:read'], expiresInDays: 30 } })).statusCode).toBe(201);
      expect((await c.request('PUT', `${P}/clinics/${C}/numbers/${encodeURIComponent('+13035550177')}`, { authorization: auth })).statusCode).toBe(204);
      await c.t.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.clinic_id', ${C}, true)`);
        const [endpoint] = (await tx.execute(sql`insert into webhook_endpoints (clinic_id, url, events, secret_enc, created_by_user_id) values (${C}, 'https://hooks.example.com/x', '{request.done}', 'x', 'u') returning id`)).rows as { id: string }[];
        await tx.execute(sql`insert into webhook_events (id, clinic_id, type, data, occurred_at) values ('evt_close', ${C}, 'request.done', '{}', now())`);
        await tx.execute(sql`insert into webhook_attempts (clinic_id, endpoint_id, event_id, kind, attempt, duration_ms) values (${C}, ${endpoint!.id}, 'evt_close', 'test', 1, 10)`);
        await tx.execute(sql`insert into sms_messages (clinic_id, template, to_hash, idempotency_key) values (${C}, 'address', 'h', 'k1')`);
        await tx.execute(sql`insert into sms_opt_outs (clinic_id, to_hash, status, source) values (${C}, 'h', 'opted_out', 'keyword')`);
        await tx.execute(sql`insert into knowledge_documents (clinic_id, title, source_type, content, content_hash, size_bytes, uploaded_by_user_id) values (${C}, 'Policies', 'text', 'x', 'h', 1, 'u')`);
      });
      const before = await rowsOf(C, c);
      for (const t of TABLES.filter((t) => !['call_actions', 'call_summaries', 'knowledge_chunks'].includes(t))) expect(before[t], t).toBeGreaterThan(0);
      const otherBefore = await rowsOf(OTHER.id, c);

      expect((await purge(C, c)).json()).toEqual({ error: 'not_closed' });
      expect((await close(true, C, c)).statusCode).toBe(204);
      const closedAt = async () => ((await c.t.db.execute(sql`select closed_at from clinics where id = ${C}`)).rows[0] as { closed_at: unknown }).closed_at;
      const first = await closedAt();
      // closing again keeps the first date
      expect((await close(true, C, c)).statusCode).toBe(204);
      expect(await closedAt()).toEqual(first);
      const recent = await purge(C, c);
      expect([recent.statusCode, recent.json()]).toEqual([409, { error: 'closed_recently' }]);
      expect((await rowsOf(C, c)).patients).toBe(before.patients);

      await c.t.db.execute(sql`update clinics set closed_at = ${new Date(now.getTime() - 31 * 86_400_000)} where id = ${C}`);
      expect((await purge(C, c)).statusCode).toBe(204);
      expect(await rowsOf(C, c)).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
      expect((await c.t.db.execute(sql`select id from clinics where id = ${C}`)).rows).toEqual([]);
      expect(await rowsOf(OTHER.id, c)).toEqual(otherBefore);
      expect((await c.t.db.execute(sql`select id from clinics where id = ${OTHER.id}`)).rows).toHaveLength(1);
      expect((await purge(C, c)).statusCode).toBe(404);
    } finally {
      await c.close();
    }
  });
});
