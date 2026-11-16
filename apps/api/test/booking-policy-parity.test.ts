import { CallAgent, CallState, ScriptedPlanner } from '@attendra/agent';
import { type BookingActor, ClinicConfig, DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { ApiKeyRepository, authenticateApiKey, CallRepository, createPhiCipher, PostgresAuditLog, PostgresPatientDirectory, PostgresTaskQueue, saveClinic } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { createMcpServer } from '@attendra/mcp/server';
import { createLogger } from '@attendra/observability';
import { BuiltinScheduler, openSlots, slotProblem } from '@attendra/scheduling';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// Foundation A, item 6: one booking rule in core (bookingPolicy). For the same clinic, visit type, day and actor, the
// phone's find_slots, MCP's find_open_slots and the scheduling search under the desk API return the same open times,
// and a time inside the notice gets the same refusal; the desk keeps its own rule for staff. A sick visit here needs
// 48 hours' notice and can be booked up to 10 days ahead. Monday 28 September 2026, 8 pm in Denver; made-up caller.
const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);
const tz = DEMO_CLINIC.timezone;
const clinic = ClinicConfig.parse({ ...DEMO_CLINIC, visitTypes: DEMO_CLINIC.visitTypes.map((v) => (v.id === 'vt_sick' ? { ...v, noticeHours: 48, maxDaysAhead: 10 } : v)) });
const C = `/api/v1/clinics/${DEMO_CLINIC.id}/appointments`;
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const iso = (d: Date) => d.toISOString();

let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
let mcp: Client;
let calls = 0;

beforeAll(async () => {
  api = await startApi({ demoMode: false, now: () => NOW });
  await saveClinic(api.t.db, 'org_demo', clinic);
  staff = await api.signIn('ana@maple.example', true);
  const { key } = await new ApiKeyRepository(api.t.db).create(DEMO_CLINIC.id, { name: 'parity', scopes: ['schedule:read'], expiresAt: new Date(Date.now() + 86_400_000), userId: api.users.owner });
  const caller = (await authenticateApiKey(api.t.db, key))!;
  const [a, b] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: 'parity', version: '1' });
  await Promise.all([createMcpServer(caller, { db: api.t.db, cipher: createPhiCipher(TEST_DATA_KEY), log, now: () => NOW }).connect(a), mcp.connect(b)]);
});
afterAll(() => api.close());

/** The phone: one find_slots on a fresh call, through the assistant's own tool, as a call runs it. */
async function phone(args: Record<string, unknown>) {
  const cipher = createPhiCipher(TEST_DATA_KEY);
  const backend = {
    events: { emit: async () => {} }, patients: new PostgresPatientDirectory(api.t.db, cipher), scheduler: new BuiltinScheduler(api.t.db, 'voice-agent', cipher),
    tasks: new PostgresTaskQueue(api.t.db, cipher), audit: new PostgresAuditLog(api.t.db), messenger: { sendTemplate: async () => ({ status: 'sent' as const, messageId: 'sms-1' }) },
  };
  const callId = await new CallRepository(api.t.db, cipher).open(DEMO_CLINIC.id, `live_parity_${++calls}`, '+13035550164');
  const scripted = new ScriptedPlanner([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: 'prov_okafor', part_of_day: 'any', from_time: null, ...args } }]);
  const state = new CallState();
  const agent = new CallAgent(state, { clinic, callId, callerNumber: '+13035550164', now: () => NOW }, backend, scripted, log);
  agent.onCallerTranscript('When can I come in for a sick visit with Dr. Okafor?', 0, 900);
  await agent.onDelegation('item_1');
  const data = scripted.results[0]!.data as { reason?: string; exact?: { time: string; free: boolean } };
  return { offered: [...state.offered.values()].map((s) => iso(s.start)), reason: data.reason ?? null, exact: data.exact ?? null };
}

/** MCP's find_open_slots for Dr. Okafor. */
async function viaMcp(from: string, days = 1) {
  const r = await mcp.callTool({ name: 'find_open_slots', arguments: { visitTypeId: 'vt_sick', providerId: 'prov_okafor', from, days } }) as unknown as { structuredContent: { slots: { startsAt: string }[]; earliestStart: string; lastDate: string | null } };
  return r.structuredContent;
}

/** The desk API's open times for Dr. Okafor (staff, signed in). */
async function desk(from: string, days = 1) {
  const res = await api.request('GET', `${C}/slots?visitTypeId=vt_sick&providerId=prov_okafor&from=${from}&days=${days}`, { cookie: staff });
  expect(res.statusCode).toBe(200);
  return res.json() as { slots: { startsAt: string }[]; leadMinutes: number };
}

/** The scheduling search every surface goes through, for one actor. */
const search = (actor: BookingActor, from: string, days = 1, limit = 20) =>
  openSlots(clinic, [], { visitTypeId: 'vt_sick', providerId: 'prov_okafor', from, days, now: NOW, actor, limit }).map((s) => iso(s.start));
const problem = (actor: BookingActor, local: [string, string]) =>
  slotProblem(clinic, [], { providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: zonedInstant(local[0], local[1], tz) }, NOW, { actor });

describe('one booking rule: the phone, MCP and the desk agree (foundation A, item 6)', () => {
  it('a day past the notice: the phone offers the first of exactly the times MCP lists, and every one is bookable by both actors', async () => {
    // Thursday, October 1: past the 48 hours (Wednesday 8 pm)
    const p = await phone({ from_date: '2026-10-01' });
    const m = await viaMcp('2026-10-01');
    expect(p.offered.length).toBe(3);
    expect(m.slots.map((s) => s.startsAt)).toEqual(search('assistant', '2026-10-01'));
    expect(p.offered).toEqual(m.slots.map((s) => s.startsAt).slice(0, 3));
    expect(p.reason).toBeNull();
    // the desk lists every start, so every time the phone or MCP offers is one the desk can book too
    const d = (await desk('2026-10-01')).slots.map((s) => s.startsAt);
    expect(d).toEqual(search('desk', '2026-10-01', 1, 5000));
    for (const t of m.slots.map((s) => s.startsAt)) {
      expect(d).toContain(t);
      expect(slotProblem(clinic, [], { providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: new Date(t) }, NOW, { actor: 'assistant' })).toBeNull();
    }
  });

  it('a time inside the notice: the same refusal from the phone and the booking check, nothing from MCP; the desk keeps its own rule', async () => {
    // Tuesday, September 29 at 10:00: 14 hours ahead, inside the 48
    const p = await phone({ from_date: '2026-09-29', from_time: '10:00', time_mode: 'at' });
    expect(p.reason).toBe('notice');
    expect(p.exact).toEqual({ time: '10:00', free: false });
    expect(p.offered.every((t) => new Date(t).getTime() >= NOW.getTime() + 48 * 3_600_000)).toBe(true);
    expect(problem('assistant', ['2026-09-29', '10:00'])).toBe('notice');
    const m = await viaMcp('2026-09-29');
    expect(m.slots).toEqual([]);
    expect(m.earliestStart).toBe(iso(new Date(NOW.getTime() + 48 * 3_600_000)));
    expect(search('assistant', '2026-09-29')).toEqual([]);
    // staff are not held to the notice: the desk lists the time and books it, from its own five minutes
    const d = await desk('2026-09-29');
    expect(d.leadMinutes).toBe(5);
    expect(d.slots.map((s) => s.startsAt)).toContain(iso(zonedInstant('2026-09-29', '10:00', tz)));
    expect(problem('desk', ['2026-09-29', '10:00'])).toBeNull();
  });

  it('a day past the furthest date: refused by the phone and the booking check, nothing from MCP, open at the desk', async () => {
    // Monday, October 12: past Thursday, October 8 (today plus 10 days)
    const p = await phone({ from_date: '2026-10-12' });
    expect(p.offered).toEqual([]);
    expect(p.reason).toBe('too_far_ahead');
    expect(problem('assistant', ['2026-10-12', '10:00'])).toBe('too_far_ahead');
    const m = await viaMcp('2026-10-12');
    expect(m.slots).toEqual([]);
    expect(m.lastDate).toBe('2026-10-08');
    // a window that runs past the last date stops at it, wherever the search starts
    const lastWeek = await viaMcp('2026-10-05', 7);
    expect(lastWeek.slots.every((s) => s.startsAt < iso(zonedInstant('2026-10-09', '00:00', tz)))).toBe(true);
    expect(lastWeek.slots.length).toBeGreaterThan(0);
    expect((await desk('2026-10-12')).slots.length).toBeGreaterThan(0);
    expect(problem('desk', ['2026-10-12', '10:00'])).toBeNull();
  });
});
