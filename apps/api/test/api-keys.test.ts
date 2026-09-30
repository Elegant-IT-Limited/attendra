import { DEMO_CLINIC } from '@attendra/core';
import { authenticateApiKey } from '@attendra/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'admin' | 'staff' | 'viewer' | 'outsider', string>;

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  as = {
    owner: await api.signIn('omar@maple.example', true), admin: await api.signIn('olga@maple.example', true), staff: await api.signIn('ana@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true), outsider: await api.signIn('otto@other.example', true),
  };
});
afterAll(() => api.close());

describe('API keys', () => {
  it('a manager makes one; the key is shown once, works for MCP, and never appears again', async () => {
    const res = await api.request('POST', `${C}/api-keys`, { cookie: as.admin, body: { name: 'Front desk agent', scopes: ['schedule:read', 'requests:read'], expiresInDays: 30 } });
    expect(res.statusCode).toBe(201);
    const { key, apiKey } = res.json();
    expect(key).toMatch(/^atk_/);
    expect(apiKey).toMatchObject({ name: 'Front desk agent', scopes: ['schedule:read', 'requests:read'], status: 'active', createdBy: 'Olga Admin', prefix: key.slice(0, 12) });
    expect(await authenticateApiKey(api.t.db, key)).toMatchObject({ clinicId: DEMO_CLINIC.id });
    const list = await api.request('GET', `${C}/api-keys`, { cookie: as.owner });
    expect(list.json().keys).toHaveLength(1);
    expect(list.body).not.toContain(key.slice(12));
  });

  it('is for owners and managers; another clinic answers 404, and a write from another origin 403', async () => {
    for (const who of ['staff', 'viewer'] as const) {
      expect((await api.request('GET', `${C}/api-keys`, { cookie: as[who] })).statusCode).toBe(403);
      expect((await api.request('POST', `${C}/api-keys`, { cookie: as[who], body: { name: 'x', scopes: ['schedule:read'] } })).statusCode).toBe(403);
    }
    expect((await api.request('GET', `${C}/api-keys`, { cookie: as.outsider })).statusCode).toBe(404);
    expect((await api.request('GET', `/api/v1/clinics/${OTHER.id}/api-keys`, { cookie: as.outsider })).json()).toEqual({ keys: [] });
    expect((await api.request('POST', `${C}/api-keys`, { cookie: as.admin, origin: 'https://evil.example', body: { name: 'x', scopes: ['schedule:read'] } })).statusCode).toBe(403);
  });

  it('checks what it is given', async () => {
    const bad = async (body: unknown) => (await api.request('POST', `${C}/api-keys`, { cookie: as.admin, body })).statusCode;
    expect(await bad({ name: '', scopes: ['schedule:read'] })).toBe(400);
    expect(await bad({ name: 'x', scopes: [] })).toBe(400);
    expect(await bad({ name: 'x', scopes: ['schedule:write'] })).toBe(400);
    // what Settings offers, 7 days to a year, is what the API takes
    expect(await bad({ name: 'x', scopes: ['schedule:read'], expiresInDays: 400 })).toBe(400);
    expect(await bad({ name: 'x', scopes: ['schedule:read'], expiresInDays: 1 })).toBe(400);
    expect(await bad({ name: 'x', scopes: ['schedule:read'], expiresInDays: 6 })).toBe(400);
  });

  it('revoking stops the key at once, audited; a second revoke is 404', async () => {
    const { key, apiKey } = (await api.request('POST', `${C}/api-keys`, { cookie: as.owner, body: { name: 'Temporary', scopes: ['requests:write'], expiresInDays: 7 } })).json();
    expect((await api.request('DELETE', `${C}/api-keys/${apiKey.id}`, { cookie: as.owner })).statusCode).toBe(204);
    expect(await authenticateApiKey(api.t.db, key)).toBeNull();
    expect((await api.request('DELETE', `${C}/api-keys/${apiKey.id}`, { cookie: as.owner })).statusCode).toBe(404);
    const listed = (await api.request('GET', `${C}/api-keys`, { cookie: as.owner })).json().keys.find((k: { id: string }) => k.id === apiKey.id);
    expect(listed.status).toBe('revoked');
    const actions = (await api.t.db.execute(sql`select action, actor from audit_logs where entity = 'api_key' order by id`)).rows;
    expect(actions).toEqual([
      { action: 'api_key.created', actor: `user:${api.users.admin}` }, { action: 'api_key.created', actor: `user:${api.users.owner}` }, { action: 'api_key.revoked', actor: `user:${api.users.owner}` },
    ]);
  });
});
