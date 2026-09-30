import { DEMO_CLINIC } from '@attendra/core';
import { addMembership, ApiKeyRepository, authenticateApiKey, CallRepository, changeTeam, createPhiCipher, PostgresTaskQueue, saveClinic, seedDemo, seedDemoSchedule } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bridge } from '../src/bridge';
import { loadBridgeEnv } from '../src/config';
import { mcpHttpHandler } from '../src/http-handler';
import { createMcpServer, type McpDeps } from '../src/server';

const cipher = createPhiCipher(TEST_DATA_KEY);
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let deps: McpDeps;
let keys: ApiKeyRepository;
let taskId: string;
const done: Record<string, string | null>[] = [];

const make = (scopes: ('schedule:read' | 'requests:read' | 'requests:write' | 'quality:read')[], clinicId = DEMO_CLINIC.id, days = 30) =>
  keys.create(clinicId, { name: `test ${scopes.join(' ')}`, scopes, expiresAt: new Date(Date.now() + days * 86_400_000), userId: 'u_olga' });

/** A client talking to a server made for this key, in memory. */
async function clientFor(key: string) {
  const caller = await authenticateApiKey(t.db, key);
  if (!caller) throw new Error('key did not authenticate');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([createMcpServer(caller, deps).connect(a), client.connect(b)]);
  return client;
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
  return { error: !!r.isError, text: r.content[0]!.text, data: r.structuredContent as Record<string, unknown> };
};
const audits = async (action: string) => (await t.db.execute(sql`select actor, entity_id, counts from audit_logs where action = ${action} order by id`)).rows as { actor: string; entity_id: string; counts: Record<string, number> | null }[];

beforeAll(async () => {
  t = await openTestDatabase();
  const { patientIds } = await seedDemo(t.db, cipher);
  await saveClinic(t.db, 'org_other', OTHER);
  await seedDemoSchedule(t.db, cipher, { patientIds, staffUserIds: ['u_jordan'], now: new Date() });
  const callId = await new CallRepository(t.db, cipher).open(DEMO_CLINIC.id, 'live_mcp_1', '+13035550163');
  ({ id: taskId } = await new PostgresTaskQueue(t.db, cipher).create(DEMO_CLINIC.id, {
    type: 'refill', callId, patientId: patientIds.james!, idempotencyKey: 'mcp-refill', details: { medication: 'lisinopril', pharmacy: 'Walgreens', callback_number: '+13035550163' },
  }));
  // the people who make keys: a key works only while its maker is an owner or practice manager
  for (const [id, org, role] of [['u_olga', 'org_demo', 'admin'], ['u_olga', 'org_other', 'admin'], ['u_owen', 'org_demo', 'owner'], ['u_mia', 'org_demo', 'admin'], ['u_max', 'org_demo', 'admin']] as const) {
    await t.db.execute(sql`insert into auth_users (id, name, email) values (${id}, ${id}, ${`${id}@example.test`}) on conflict do nothing`);
    await addMembership(t.db, org, id, role);
  }
  keys = new ApiKeyRepository(t.db);
  deps = { db: t.db, cipher, log, onRequestDone: async (_c, f) => { done.push(f); } };
});
afterAll(() => t.close());

describe('API keys', () => {
  it('are shown once and stored only as a SHA-256 hash, and made and revoked with an audit row', async () => {
    const { id, key } = await make(['schedule:read']);
    expect(key).toMatch(/^atk_[A-Za-z0-9_-]{43}$/);
    const stored = (await t.db.execute(sql`select key_hash, prefix from api_keys where id = ${id}`)).rows[0] as { key_hash: string; prefix: string };
    expect(stored.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(key.slice(12));
    expect(stored.prefix).toBe(key.slice(0, 12));
    expect(await authenticateApiKey(t.db, key)).toMatchObject({ keyId: id, clinicId: DEMO_CLINIC.id, scopes: ['schedule:read'] });
    expect(await keys.revoke(DEMO_CLINIC.id, id, 'u_olga')).toBe(true);
    expect(await authenticateApiKey(t.db, key)).toBeNull();
    expect((await audits('api_key.created')).map((a) => a.entity_id)).toContain(id);
    expect((await audits('api_key.revoked')).map((a) => a.entity_id)).toEqual([id]);
  });

  it('stop working when their maker is removed or no longer an owner or manager, and are revoked with an audit row', async () => {
    const mia = await keys.create(DEMO_CLINIC.id, { name: 'mia', scopes: ['schedule:read'], expiresAt: new Date(Date.now() + 86_400_000), userId: 'u_mia' });
    const max = await keys.create(DEMO_CLINIC.id, { name: 'max', scopes: ['schedule:read'], expiresAt: new Date(Date.now() + 86_400_000), userId: 'u_max' });
    const client = await clientFor(mia.key);
    expect(await authenticateApiKey(t.db, mia.key)).not.toBeNull();
    const owner = { userId: 'u_owen', role: 'owner' as const };
    expect(await changeTeam(t.db, 'org_demo', owner, { type: 'role', userId: 'u_mia', role: 'staff' })).toBe('done');
    expect(await authenticateApiKey(t.db, mia.key)).toBeNull();
    expect(await call(client, 'find_open_slots', { visitTypeId: 'vt_sick' })).toMatchObject({ error: true, text: expect.stringContaining('revoked') });
    expect(await changeTeam(t.db, 'org_demo', owner, { type: 'remove', userId: 'u_max' })).toBe('done');
    expect(await authenticateApiKey(t.db, max.key)).toBeNull();
    const revoked = (await t.db.execute(sql`select entity_id, actor from audit_logs where action = 'api_key.revoked' and entity_id in (${mia.id}, ${max.id}) order by id`)).rows;
    expect(revoked).toEqual([{ entity_id: mia.id, actor: 'user:u_owen' }, { entity_id: max.id, actor: 'user:u_owen' }]);
    // a role changed some other way (the member CLI) stops the key too, even before it is revoked
    const olga = await make(['schedule:read']);
    await addMembership(t.db, 'org_demo', 'u_olga', 'viewer');
    expect(await authenticateApiKey(t.db, olga.key)).toBeNull();
    await addMembership(t.db, 'org_demo', 'u_olga', 'admin');
    expect(await authenticateApiKey(t.db, olga.key)).not.toBeNull();
  });

  it('stop working when they expire, and nothing else works either', async () => {
    const { key } = await make(['schedule:read'], DEMO_CLINIC.id, 1);
    expect(await authenticateApiKey(t.db, key, new Date(Date.now() + 2 * 86_400_000))).toBeNull();
    expect(await authenticateApiKey(t.db, 'atk_' + 'x'.repeat(43))).toBeNull();
    expect(await authenticateApiKey(t.db, 'not a key')).toBeNull();
  });
});

describe('the tools', () => {
  it('lists five tools, none of which can book or cancel', async () => {
    const client = await clientFor((await make(['schedule:read'])).key);
    const names = (await client.listTools()).tools.map((x) => x.name).sort();
    expect(names).toEqual(['find_open_slots', 'get_quality_summary', 'list_open_requests', 'list_todays_schedule', 'mark_request_done']);
    expect(names.some((n) => /book|cancel/.test(n))).toBe(false);
  });

  it('find_open_slots needs schedule:read, and returns times with no patient data', async () => {
    const withScope = await clientFor((await make(['schedule:read'])).key);
    const r = await call(withScope, 'find_open_slots', { visitTypeId: 'vt_sick', days: 7 });
    expect(r.error).toBe(false);
    expect((r.data.slots as unknown[]).length).toBeGreaterThan(0);
    expect(r.text).not.toMatch(/Delgado|Whitaker/);
    const without = await clientFor((await make(['requests:read'])).key);
    const refused = await call(without, 'find_open_slots', { visitTypeId: 'vt_sick' });
    expect(refused).toMatchObject({ error: true, text: expect.stringContaining('schedule:read') });
  });

  it('list_todays_schedule needs schedule:read, names patients, and audits how many it showed', async () => {
    const named = await call(await clientFor((await make(['schedule:read'])).key), 'list_todays_schedule');
    const appts = named.data.appointments as { patient?: string }[];
    if (appts.length) expect(appts.every((a) => !!a.patient)).toBe(true);
    const rows = await audits('mcp.list_todays_schedule');
    expect(rows.at(-1)!.counts).toEqual({ appointments: appts.length, names: appts.length });
    expect(rows.every((r) => r.actor.startsWith('api_key:'))).toBe(true);
    const bare = await call(await clientFor((await make(['requests:read'])).key), 'list_todays_schedule');
    expect(bare).toMatchObject({ error: true, text: expect.stringContaining('schedule:read') });
    expect((await audits('mcp.list_todays_schedule.refused')).length).toBeGreaterThan(0);
  });

  it('list_open_requests needs requests:read; mark_request_done needs requests:write and announces the change', async () => {
    const reader = await clientFor((await make(['requests:read'])).key);
    const list = await call(reader, 'list_open_requests');
    expect(list.data.requests).toEqual([expect.objectContaining({ requestId: taskId, type: 'refill', patient: 'James Whitaker', details: expect.objectContaining({ medication: 'lisinopril' }) })]);
    expect(await call(reader, 'mark_request_done', { requestId: taskId, outcome: 'refill_sent' })).toMatchObject({ error: true, text: expect.stringContaining('requests:write') });
    const writer = await clientFor((await make(['requests:write'])).key);
    expect((await call(writer, 'mark_request_done', { requestId: taskId, outcome: 'refill_sent' })).data).toEqual({ requestId: taskId, status: 'done' });
    expect(done.at(-1)).toMatchObject({ requestId: taskId, type: 'refill', outcome: 'refill_sent' });
    expect((await call(writer, 'mark_request_done', { requestId: '00000000-0000-4000-8000-000000000000', outcome: 'not_needed' })).data.status).toBe('not_found');
    expect((await call(reader, 'list_open_requests')).data.requests).toEqual([]);
  });

  it('get_quality_summary needs quality:read, and holds counts only', async () => {
    const r = await call(await clientFor((await make(['quality:read'])).key), 'get_quality_summary');
    expect(r.data).toMatchObject({ days: 7, calls: 1, containmentRate: 0, bookingSuccess: null });
    expect(r.text).not.toMatch(/Whitaker|lisinopril/);
    expect(await call(await clientFor((await make(['requests:read'])).key), 'get_quality_summary')).toMatchObject({ error: true, text: expect.stringContaining('quality:read') });
  });

  it('audits every use, refused ones too, with the key\'s id; a key sees only its own clinic', async () => {
    const { id, key } = await make(['requests:read'], OTHER.id);
    const theirs = await clientFor(key);
    expect((await call(theirs, 'list_open_requests')).data.requests).toEqual([]);
    await call(theirs, 'find_open_slots', { visitTypeId: 'vt_sick' });
    const rows = (await t.db.execute(sql`select clinic_id, action from audit_logs where entity_id = ${id} order by id`)).rows;
    expect(rows).toEqual([
      { clinic_id: OTHER.id, action: 'api_key.created' }, { clinic_id: OTHER.id, action: 'mcp.list_open_requests' }, { clinic_id: OTHER.id, action: 'mcp.find_open_slots.refused' },
    ]);
  });
});

describe('Streamable HTTP', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    const handle = mcpHttpHandler(deps);
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => server.close());

  it('refuses a request with no key, or a bad one', async () => {
    const post = (auth?: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect((await post()).status).toBe(401);
    expect((await post('Bearer atk_nope')).status).toBe(401);
    expect((await fetch(url.replace('/mcp', '/other'), { method: 'POST' })).status).toBe(404);
  });

  it('serves the tools to a client with a key', async () => {
    const { key } = await make(['schedule:read']);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    expect((await client.listTools()).tools).toHaveLength(5);
    const r = await client.callTool({ name: 'find_open_slots', arguments: { visitTypeId: 'vt_annual', days: 5 } }) as { isError?: boolean };
    expect(r.isError).toBeFalsy();
    await client.close();
  });
});

describe('rate limits', () => {
  it('refuse a key over its allowance, and an address that keeps failing to authenticate', async () => {
    const handle = mcpHttpHandler({ ...deps, rateLimit: { failuresPerAddress: 3, perKey: 4 } });
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const post = (auth: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: auth }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }).then((r) => r.status);
    const { key } = await make(['schedule:read']);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await post(`Bearer ${key}`));
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    expect([await post('Bearer atk_x'), await post('Bearer atk_y'), await post('Bearer atk_z'), await post('Bearer atk_w')]).toEqual([401, 401, 401, 429]);
    // while the address is held back, even a working key from it waits the minute out
    expect(await post(`Bearer ${(await make(['schedule:read'])).key}`)).toBe(429);
    server.close();
  });
});

describe('the stdio bridge', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    const handle = mcpHttpHandler(deps);
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => server.close());

  /** A desktop MCP client on one side of the bridge, the HTTP server on the other. */
  async function bridged(key: string) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await bridge(a, new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    const client = new Client({ name: 'desktop', version: '1' });
    await client.connect(b);
    return client;
  }

  it('needs only the server\'s address and a key: no database, no data key', () => {
    const env = loadBridgeEnv({ ATTENDRA_MCP_URL: 'https://mcp.clinic.example/mcp', ATTENDRA_API_KEY: `atk_${'a'.repeat(43)}` });
    expect(Object.keys(env).sort()).toEqual(['ATTENDRA_API_KEY', 'ATTENDRA_MCP_URL', 'LOG_LEVEL']);
    expect(() => loadBridgeEnv({ ATTENDRA_MCP_URL: 'http://mcp.clinic.example/mcp', ATTENDRA_API_KEY: `atk_${'a'.repeat(43)}` })).toThrow(/https/);
    expect(() => loadBridgeEnv({ ATTENDRA_MCP_URL: 'https://mcp.clinic.example/mcp' })).toThrow(/ATTENDRA_API_KEY/);
  });

  it('relays the tools, and a key revoked while connected fails on the very next call', async () => {
    const { id, key } = await make(['schedule:read']);
    const client = await bridged(key);
    expect((await client.listTools()).tools).toHaveLength(5);
    expect((await call(client, 'find_open_slots', { visitTypeId: 'vt_sick', days: 3 })).error).toBe(false);
    await keys.revoke(DEMO_CLINIC.id, id, 'u_olga');
    await expect(client.callTool({ name: 'find_open_slots', arguments: { visitTypeId: 'vt_sick', days: 3 } })).rejects.toThrow(/revoked or expired/);
    await client.close();
  });
});

describe('a connected server', () => {
  it('checks the key again before every tool call', async () => {
    const { id, key } = await make(['schedule:read']);
    const client = await clientFor(key);
    expect((await call(client, 'find_open_slots', { visitTypeId: 'vt_sick', days: 3 })).error).toBe(false);
    await keys.revoke(DEMO_CLINIC.id, id, 'u_olga');
    expect(await call(client, 'find_open_slots', { visitTypeId: 'vt_sick', days: 3 })).toMatchObject({ error: true, text: expect.stringContaining('revoked') });
  });
});
