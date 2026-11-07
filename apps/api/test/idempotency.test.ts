import { DEMO_CLINIC } from '@attendra/core';
import { claimIdempotencyKey, IDEMPOTENCY_KEPT_HOURS, IDEMPOTENCY_PENDING_MS, pruneIdempotencyKeys } from '@attendra/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPLAYED_HEADER } from '../src/http/idempotency';
import { signRequest } from '../src/http/signature';
import { startApi } from './helpers';

/**
 * Every POST may carry an Idempotency-Key: sent again, the same request is answered again
 * and nothing is done twice; the same key with another body is refused; keys are per person
 * and per path; a failure frees the key; the kept answer is encrypted.
 */
const TOKEN = 'p'.repeat(40);
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let ana: string;
let omar: string;
beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional', provisioningToken: TOKEN });
  ana = await api.signIn('ana@maple.example');
  omar = await api.signIn('omar@maple.example');
});
afterAll(() => api.close());

const request = (name: string) => ({ type: 'callback', topic: null, name, patientId: null, reason: 'asked about a refill', callbackNumber: null, urgent: false, dueOn: null });
const tasksNamed = async (name: string) => {
  // every request at the clinic: the tests here only ever add to it
  const rows = await api.t.db.execute<{ n: number }>(sql`select count(*)::int as n from tasks where clinic_id = ${DEMO_CLINIC.id}`);
  return { name, n: rows.rows[0]!.n };
};

describe('a POST sent twice with the same key', () => {
  it('is done once, and answered the same way both times', async () => {
    const before = (await tasksNamed('Juniper Vale')).n;
    const first = await api.request('POST', `${C}/tasks`, { cookie: ana, body: request('Juniper Vale'), headers: { 'idempotency-key': 'retry-0001-juniper' } });
    expect(first.statusCode).toBe(201);
    expect(first.headers[REPLAYED_HEADER]).toBeUndefined();
    const again = await api.request('POST', `${C}/tasks`, { cookie: ana, body: request('Juniper Vale'), headers: { 'idempotency-key': 'retry-0001-juniper' } });
    expect(again.statusCode).toBe(201);
    expect(again.headers[REPLAYED_HEADER]).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect((await tasksNamed('Juniper Vale')).n).toBe(before + 1);
  });

  it('with another body, is refused instead of answered with the first', async () => {
    await api.request('POST', `${C}/tasks`, { cookie: ana, body: request('Rowan Pike'), headers: { 'idempotency-key': 'retry-0002-rowan' } });
    const other = await api.request('POST', `${C}/tasks`, { cookie: ana, body: request('Someone Else'), headers: { 'idempotency-key': 'retry-0002-rowan' } });
    expect(other.statusCode).toBe(422);
    expect(other.json().error).toBe('idempotency_key_reused');
  });

  it('belongs to the person who sent it: another person\'s same key is a new request', async () => {
    const before = (await tasksNamed('x')).n;
    await api.request('POST', `${C}/tasks`, { cookie: ana, body: request('Hazel Moss'), headers: { 'idempotency-key': 'shared-key-0003' } });
    const byOmar = await api.request('POST', `${C}/tasks`, { cookie: omar, body: request('Hazel Moss'), headers: { 'idempotency-key': 'shared-key-0003' } });
    expect(byOmar.headers[REPLAYED_HEADER]).toBeUndefined();
    expect((await tasksNamed('x')).n).toBe(before + 2);
  });

  it('a key that is not one is refused before anything is done', async () => {
    const before = (await tasksNamed('x')).n;
    const res = await api.request('POST', `${C}/tasks`, { cookie: ana, body: request('Ivy Lane'), headers: { 'idempotency-key': 'short' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_idempotency_key');
    expect((await tasksNamed('x')).n).toBe(before);
  });

  it('a request that failed frees its key, so the retry runs', async () => {
    const bad = await api.request('POST', `${C}/tasks`, { cookie: ana, body: { ...request('Fern Ash'), type: 'not-a-type' }, headers: { 'idempotency-key': 'retry-0004-fern' } });
    expect(bad.statusCode).toBe(422);
    const rows = await api.t.db.execute<{ n: number }>(sql`select count(*)::int as n from idempotency_keys where key = 'retry-0004-fern'`);
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('keeps the answer encrypted: no name in the stored row', async () => {
    await api.request('POST', `${C}/tasks`, { cookie: ana, body: request('Clementine Rook'), headers: { 'idempotency-key': 'retry-0005-clementine' } });
    const rows = await api.t.db.execute<{ response: string | null }>(sql`select response from idempotency_keys where key = 'retry-0005-clementine'`);
    expect(rows.rows[0]!.response).toBeTruthy();
    expect(rows.rows[0]!.response).not.toContain('Clementine');
  });

  it('without a key, nothing changes: each request is its own', async () => {
    const before = (await tasksNamed('x')).n;
    await api.request('POST', `${C}/tasks`, { cookie: ana, body: request('Basil Grey') });
    await api.request('POST', `${C}/tasks`, { cookie: ana, body: request('Basil Grey') });
    expect((await tasksNamed('x')).n).toBe(before + 2);
  });
});

describe('the hosting layer\'s POSTs', () => {
  it('are kept under the hosting layer\'s own name, signed or not', async () => {
    const account = { organization: { name: 'Birch Lane Vets' }, clinic: { name: 'Birch Lane Vets', timezone: 'America/Chicago', industry: 'vet', phone: '+13125550142' }, owner: { name: 'Remy Birch', email: 'remy@birchlane.example', password: 'a-long-password-1' }, testCallMinutes: 10, plan: 'trial' };
    const path = '/api/v1/provisioning/accounts';
    const headers = { 'idempotency-key': 'open-birch-lane-0001', ...signRequest(TOKEN, { method: 'POST', path, body: JSON.stringify(account) }) };
    const first = await api.request('POST', path, { body: account, headers });
    expect(first.statusCode).toBe(201);
    const again = await api.request('POST', path, { body: account, headers });
    expect(again.statusCode).toBe(201);
    expect(again.headers[REPLAYED_HEADER]).toBe('true');
    expect(again.json()).toEqual(first.json());
    const rows = await api.t.db.execute<{ scope: string }>(sql`select scope from idempotency_keys where key = 'open-birch-lane-0001'`);
    expect(rows.rows[0]!.scope).toBe(`provisioning POST ${path}`);
  });
});

describe('the store', () => {
  it('a key still being answered says so; one whose request died, or that is past keeping, is taken again', async () => {
    const t0 = new Date('2026-11-07T12:00:00.000Z');
    expect(await claimIdempotencyKey(api.t.db, 'user:test POST /x', 'store-key-0001', 'h1', t0)).toEqual({ kind: 'new' });
    expect(await claimIdempotencyKey(api.t.db, 'user:test POST /x', 'store-key-0001', 'h1', new Date(t0.getTime() + 1000))).toEqual({ kind: 'in_progress' });
    expect(await claimIdempotencyKey(api.t.db, 'user:test POST /x', 'store-key-0001', 'h1', new Date(t0.getTime() + IDEMPOTENCY_PENDING_MS + 1000))).toEqual({ kind: 'new' });
    expect(await pruneIdempotencyKeys(api.t.db, new Date(t0.getTime() + (IDEMPOTENCY_KEPT_HOURS + 1) * 3_600_000))).toBeGreaterThan(0);
  });
});
