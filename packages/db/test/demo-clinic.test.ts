import { type ClinicConfig, clinicDay, DEMO_LIMITS, RIVERBEND_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, DEMO_LIMIT_TOOL, demoClinics, demoState, demoUsage, PostgresTaskQueue, resetDemoClinic, RIVERBEND_PETS, seedDemoClinic, setDemoBaseline, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

/**
 * A demo clinic's baseline and reset (2026-11-16), and the limits' counts. Two vet clinics hold the same pets, visits and
 * requests; only A is a demo clinic. Everything a caller can do on A (book, move a seed visit, cancel, add a pet, leave a
 * request, a note on it, change a seed pet) is undone by A's reset, and B, with the same rows and the same changes, is
 * left exactly as it was by every demo path.
 */
const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
const A: ClinicConfig = { ...RIVERBEND_CLINIC, id: 'clinic_demo_a', name: 'Demo A Vet', phoneNumbers: ['+17205550191'] };
const B: ClinicConfig = { ...RIVERBEND_CLINIC, id: 'clinic_demo_b', name: 'Demo B Vet', phoneNumbers: ['+17205550192'] };
const NOW = new Date('2026-11-16T15:00:00Z');
const TABLES = ['patients', 'patient_search_keys', 'appointments', 'tasks', 'task_notes'] as const;
const pets: Record<string, Record<string, string>> = {};

/** Every row of the clinic's operational tables, and its calls, as the database's own JSON: what "untouched" compares. */
async function rowsOf(clinicId: string) {
  return withClinic(t.db, clinicId, async (tx) => {
    const out: Record<string, string[]> = {};
    for (const table of [...TABLES, 'calls', 'call_actions']) {
      const rows = (await tx.execute(sql`select to_jsonb(x)::text as r from ${sql.identifier(table)} x where x.clinic_id = ${clinicId}`)).rows as { r: string }[];
      out[table] = rows.map((r) => r.r).sort();
    }
    return out;
  });
}

const provider = RIVERBEND_CLINIC.providers[0]!;
const visitType = RIVERBEND_CLINIC.visitTypes[0]!;
async function book(clinicId: string, patientId: string, startsAt: string, key: string) {
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + visitType.minutes * 60_000);
  return withClinic(t.db, clinicId, async (tx) => {
    const [r] = (await tx.execute(sql`insert into appointments (clinic_id, patient_id, provider_id, visit_type_id, starts_at, ends_at, idempotency_key, created_by_user_id)
      values (${clinicId}, ${patientId}, ${provider.id}, ${visitType.id}, ${start}, ${end}, ${key}, 'user_x') returning id`)).rows as [{ id: string }];
    return r.id;
  });
}
const setDemo = (clinicId: string, enabled: boolean) => t.owner.execute(sql`update clinics set config = jsonb_set(config, '{demoClinic}', ${JSON.stringify({ enabled, baselineAt: null })}::jsonb) where id = ${clinicId}`);

/** The same seed in a clinic: four pets, two visits, one request with a note. */
async function seed(c: ClinicConfig, org: string) {
  const { patientIds } = await seedDemoClinic(t.db, cipher, c, org, RIVERBEND_PETS);
  pets[c.id] = patientIds;
  const v1 = await book(c.id, patientIds.biscuit!, '2026-11-18T16:00:00Z', `${c.id}:seed1`);
  const v2 = await book(c.id, patientIds.luna!, '2026-11-19T16:00:00Z', `${c.id}:seed2`);
  const task = await new PostgresTaskQueue(t.db, cipher, 'seed').create(c.id, { type: 'callback', callId: null, patientId: patientIds.pepper!, idempotencyKey: `${c.id}:seed-task`, details: { reason: 'Seed request.' } });
  return { v1, v2, taskId: task.id };
}

/** What a day of demo callers does to a clinic: the same on A and on B. */
async function callersChange(c: ClinicConfig, seedRows: { v1: string; v2: string; taskId: string }) {
  const calls = new CallRepository(t.db, cipher);
  const callId = await calls.open(c.id, `sess_${c.id}_1`, '+17205550199', 'phone');
  const newPet = await seedDemoClinic(t.db, cipher, c, c.id === A.id ? 'org_demo_a' : 'org_demo_b', [{ key: 'nova', firstName: 'Nova', lastName: 'Park', dob: '2022-01-05', phone: '+17205550199', guardianName: 'Sam Park', species: 'dog' }]);
  const novaId = newPet.patientIds.nova!;
  await calls.recordAction(c.id, callId, { tool: 'register_patient', argsRedacted: {}, result: { ok: true }, taskRevision: 1, patientId: novaId });
  await calls.close(c.id, callId, { reason: 'caller_hangup', voiceSeconds: 60, outcome: 'booked', emergency: false });
  await book(c.id, novaId, '2026-11-20T16:00:00Z', `${c.id}:new`);
  await withClinic(t.db, c.id, async (tx) => {
    // a seed visit moved, the other cancelled, a seed pet's texting consent changed
    await tx.execute(sql`update appointments set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour', updated_at = ${NOW} where clinic_id = ${c.id} and id = ${seedRows.v1}`);
    await tx.execute(sql`update appointments set status = 'cancelled', cancel_reason = 'patient_asked', updated_at = ${NOW} where clinic_id = ${c.id} and id = ${seedRows.v2}`);
    await tx.execute(sql`update patients set sms_consent_at = ${NOW}, sms_consent_source = 'call' where clinic_id = ${c.id} and id = ${pets[c.id]!.mochi!}`);
    await tx.execute(sql`insert into task_notes (clinic_id, task_id, author_user_id, body_enc) values (${c.id}, ${seedRows.taskId}, 'user_x', 'v1.a.b.c')`);
  });
  await new PostgresTaskQueue(t.db, cipher, 'voice-agent').create(c.id, { type: 'callback', callId, patientId: novaId, idempotencyKey: `${c.id}:caller-task`, details: { reason: 'A caller asked for a callback.' } });
  return callId;
}

let seedA: Awaited<ReturnType<typeof seed>>;
let seedB: Awaited<ReturnType<typeof seed>>;
beforeAll(async () => {
  t = await openTestDatabase();
  seedA = await seed(A, 'org_demo_a');
  seedB = await seed(B, 'org_demo_b');
});
afterAll(() => t.close());

describe('demo clinic: baseline and reset', () => {
  it('refuses a clinic that is not a demo clinic, and an unknown one', async () => {
    expect(await setDemoBaseline(t.db, cipher, A.id, 'owner@example.com', NOW)).toEqual({ ok: false, error: 'not_demo' });
    expect(await resetDemoClinic(t.db, cipher, A.id, 'owner@example.com', NOW)).toEqual({ ok: false, error: 'not_demo' });
    expect(await setDemoBaseline(t.db, cipher, 'clinic_nope', 'owner@example.com', NOW)).toEqual({ ok: false, error: 'not_found' });
    expect(await demoClinics(t.db)).toEqual([]);
  });

  it('a demo clinic has no reset before its baseline is set', async () => {
    await setDemo(A.id, true);
    expect(await resetDemoClinic(t.db, cipher, A.id, 'owner@example.com', NOW)).toEqual({ ok: false, error: 'no_baseline' });
    expect(await demoClinics(t.db)).toEqual([{ clinicId: A.id, timezone: A.timezone, lastResetAt: null, hasBaseline: false }]);
  });

  it('puts back exactly the baseline: a booking, a moved visit, a cancel, a new pet, a request and a note are undone; B is untouched', async () => {
    const baseline = await rowsOf(A.id);
    const set = await setDemoBaseline(t.db, cipher, A.id, 'owner@example.com', NOW);
    expect(set).toEqual({ ok: true, takenAt: NOW.toISOString(), counts: { patients: 4, patient_search_keys: baseline.patient_search_keys!.length, appointments: 2, tasks: 1, task_notes: 0 } });
    const state = await demoState(t.db, A.id);
    expect(state).toMatchObject({ enabled: true, baselineAt: NOW.toISOString(), baselineBy: 'owner@example.com', lastResetAt: null });

    const callA = await callersChange(A, seedA);
    await callersChange(B, seedB);
    const bBefore = await rowsOf(B.id);
    const aChanged = await rowsOf(A.id);
    expect(aChanged.patients).toHaveLength(5);
    expect(aChanged.appointments).toHaveLength(3);

    // a dry run counts and changes nothing
    const dry = await resetDemoClinic(t.db, cipher, A.id, 'owner@example.com', NOW, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(await rowsOf(A.id)).toEqual(aChanged);

    const reset = await resetDemoClinic(t.db, cipher, A.id, 'worker', NOW);
    expect(reset).toMatchObject({ ok: true, baselineAt: NOW.toISOString() });
    if (!reset.ok) return;
    expect(reset.counts).toMatchObject({
      patients: { added: 1, changed: 1, missing: 0 }, appointments: { added: 1, changed: 2, missing: 0 },
      tasks: { added: 1, changed: 0, missing: 0 }, task_notes: { added: 1, changed: 0, missing: 0 }, callsUnlinked: 1,
    });
    const after = await rowsOf(A.id);
    for (const table of TABLES) expect(after[table], table).toEqual(baseline[table]);
    // calls stay (retention decides), with no link to the pet that is gone; their steps stay too
    expect(after.calls).toHaveLength(1);
    expect(JSON.parse(after.calls![0]!)).toMatchObject({ id: callA, patient_id: null });
    expect(after.call_actions).toEqual(aChanged.call_actions);
    // the other clinic, with the same rows and the same changes, is exactly as it was
    expect(await rowsOf(B.id)).toEqual(bBefore);
    expect(await demoState(t.db, A.id)).toMatchObject({ lastResetAt: NOW.toISOString(), lastResetCounts: { callsUnlinked: 1 } });
    // settings are never touched by a reset
    const [cfg] = (await t.owner.execute(sql`select config->'providers' as p, config->'visitTypes' as v from clinics where id = ${A.id}`)).rows as [{ p: unknown; v: unknown }];
    expect(cfg.p).toEqual(JSON.parse(JSON.stringify(A.providers)));
    expect(cfg.v).toEqual(JSON.parse(JSON.stringify(A.visitTypes)));
  });

  it('a second reset changes nothing, and the audit log records each with counts only', async () => {
    const before = await rowsOf(A.id);
    const again = await resetDemoClinic(t.db, cipher, A.id, 'worker', new Date(NOW.getTime() + 60_000));
    expect(again).toMatchObject({ ok: true, counts: { patients: { added: 0, changed: 0, missing: 0 }, appointments: { added: 0, changed: 0, missing: 0 }, callsUnlinked: 0 } });
    expect(await rowsOf(A.id)).toEqual(before);
    const audit = (await withClinic(t.db, A.id, (tx) => tx.execute(sql`select action, actor, counts from audit_logs where clinic_id = ${A.id} and action like 'demo.%' order by id`))).rows as { action: string; actor: string; counts: Record<string, number> }[];
    expect(audit.map((a) => [a.action, a.actor])).toEqual([['demo.baseline_set', 'owner@example.com'], ['demo.reset', 'worker'], ['demo.reset', 'worker']]);
    expect(Object.values(audit[1]!.counts).every((n) => typeof n === 'number')).toBe(true);
    const bAudit = (await withClinic(t.db, B.id, (tx) => tx.execute(sql`select count(*)::int as n from audit_logs where clinic_id = ${B.id} and action like 'demo.%'`))).rows as [{ n: number }];
    expect(Number(bAudit[0].n)).toBe(0);
  });

  it('waits while a call is going', async () => {
    const calls = new CallRepository(t.db, cipher);
    const live = await calls.open(A.id, 'sess_live', '+17205550198', 'phone');
    expect(await resetDemoClinic(t.db, cipher, A.id, 'worker', new Date())).toEqual({ ok: false, error: 'call_in_progress' });
    await calls.close(A.id, live, { reason: 'caller_hangup', voiceSeconds: 5, outcome: 'abandoned', emergency: false });
  });

  it('turned off, nothing runs on it any more', async () => {
    await setDemo(A.id, false);
    expect(await resetDemoClinic(t.db, cipher, A.id, 'worker', NOW)).toEqual({ ok: false, error: 'not_demo' });
    expect(await demoClinics(t.db)).toEqual([]);
    await setDemo(A.id, true);
  });
});

describe('demo clinic: today\'s use of the line', () => {
  const day = clinicDay(A.timezone, new Date());
  it('counts a caller\'s answered calls by the number\'s hash, the clinic\'s seconds, and the refusals by code', async () => {
    const calls = new CallRepository(t.db, cipher);
    const from = '+17205550177';
    const before = await demoUsage(t.db, cipher, A.id, from, day, new Date());
    expect(before.callerCalls).toBe(0);
    for (let i = 0; i < 2; i++) {
      const id = await calls.open(A.id, `sess_use_${i}`, from, 'phone');
      await calls.close(A.id, id, { reason: 'caller_hangup', voiceSeconds: 30, outcome: 'info', emergency: false });
    }
    // a refused call does not count against the caller, but is counted as a refusal
    const refused = await calls.open(A.id, 'sess_use_refused', from, 'phone');
    await calls.recordAction(A.id, refused, { tool: DEMO_LIMIT_TOOL, argsRedacted: {}, result: { code: 'demo_clinic_minutes' }, taskRevision: 1 });
    await calls.close(A.id, refused, { reason: 'agent_hangup', voiceSeconds: 8, outcome: 'abandoned', emergency: false });
    // a browser test call is staff's, never counted
    const web = await calls.open(A.id, 'sess_use_web', null, 'web', 'user_x');
    await calls.close(A.id, web, { reason: 'session_closed', voiceSeconds: 600, outcome: 'info', emergency: false });
    const u = await demoUsage(t.db, cipher, A.id, from, day, new Date());
    expect(u.callerCalls).toBe(2);
    expect(u.refusedToday).toEqual({ demo_caller_calls: 0, demo_clinic_minutes: 1 });
    expect(u.clinicSeconds).toBeGreaterThanOrEqual(before.clinicSeconds);
    // another number, and the other clinic, see none of it
    expect((await demoUsage(t.db, cipher, A.id, '+17205550176', day, new Date())).callerCalls).toBe(0);
    expect(await demoUsage(t.db, cipher, B.id, from, day, new Date())).toMatchObject({ callerCalls: 0, refusedToday: { demo_caller_calls: 0, demo_clinic_minutes: 0 } });
  });

  it('a call never counts longer than a demo call may last, even one left open', async () => {
    const calls = new CallRepository(t.db, cipher);
    const id = await calls.open(A.id, 'sess_stuck', '+17205550175', 'phone');
    await withClinic(t.db, A.id, (tx) => tx.execute(sql`update calls set started_at = now() - interval '3 hours' where clinic_id = ${A.id} and id = ${id}`));
    const u1 = await demoUsage(t.db, cipher, A.id, null, { start: new Date(Date.now() - 4 * 3_600_000), end: new Date(Date.now() + 60_000) }, new Date());
    const total = (await withClinic(t.db, A.id, (tx) => tx.execute(sql`select count(*)::int as n from calls where clinic_id = ${A.id} and channel = 'phone'`))).rows as [{ n: number }];
    expect(u1.clinicSeconds).toBeLessThanOrEqual(Number(total[0].n) * DEMO_LIMITS.callSeconds);
    expect(u1.callerCalls).toBe(0);
  });
});
