import { DEMO_CLINIC, RIVERBEND_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMembership, CallRepository, createPhiCipher, FrontDeskRepository, PostgresPatientDirectory, PostgresTaskQueue, saveClinic, seedDemo, seedRiverbend } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';
import { phoneKey } from '../src/repositories/patients';

const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let pets: Record<string, string>;
const V = RIVERBEND_CLINIC.id;

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  ({ patientIds: pets } = await seedRiverbend(t.db, cipher));
  await saveClinic(t.db, 'org_other', { ...DEMO_CLINIC, id: 'clinic_numbers_other', name: 'Other', phoneNumbers: ['+13035550120'] });
  await t.owner.execute(sql`insert into auth_users (id, name, email) values ('u_num', 'Nia Desk', 'nia@example.test')`);
  await addMembership(t.db, 'org_riverbend', 'u_num', 'staff');
});
afterAll(() => t.close());

const queue = () => new PostgresTaskQueue(t.db, cipher);
// the number each key got when the twelve came in at once: on a real server they arrive in any order
const firstNumbers = new Map<string, number>();
const numbersOf = async (clinicId: string) => ((await t.owner.execute(sql`select number from tasks where clinic_id = ${clinicId} order by number`)).rows as { number: number }[]).map((r) => r.number);

// every request has its own number (2026-11-01): R-1042, in the order they came in, never reused
describe('request numbers', () => {
  it('numbers requests one after another, each clinic from R-1, even when many come in at once', async () => {
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => queue().create(V, { type: 'callback', callId: null, patientId: null, idempotencyKey: `n-${i}`, details: { reason: `call ${i}` } })));
    made.forEach((m, i) => firstNumbers.set(`n-${i}`, m.number));
    expect(made.map((m) => m.number).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(new Set(made.map((m) => m.number)).size).toBe(12);
    // another clinic starts at R-1 too
    const other = await queue().create('clinic_numbers_other', { type: 'callback', callId: null, patientId: null, idempotencyKey: 'o-1', details: { reason: 'first here' } });
    expect(other.number).toBe(1);
    expect(await numbersOf(V)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('a retried request keeps its number and costs none; the next new one follows on', async () => {
    const again = await queue().create(V, { type: 'callback', callId: null, patientId: null, idempotencyKey: 'n-3', details: { reason: 'call 3' } });
    expect(again).toMatchObject({ number: firstNumbers.get('n-3'), created: false });
    const next = await queue().create(V, { type: 'callback', callId: null, patientId: null, idempotencyKey: 'n-13', details: { reason: 'the next' } });
    expect(next).toMatchObject({ number: 13, created: true });
    const audit = (await t.owner.execute(sql`select counts from audit_logs where clinic_id = ${V} and action = 'task.created.callback' and entity_id = ${next.id}`)).rows as { counts: { number: number } }[];
    expect(audit).toEqual([{ counts: { number: 13 } }]);
  });

  it('belongs to the household: the record it is about, or the number the call came from when a record is on it', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const mochi = await dir.findPet(V, 'Mochi', '+17205550172');
    expect(mochi.status).toBe('found');
    const household = cipher.hash(phoneKey(V, '+17205550172'));
    const linked = await queue().create(V, { type: 'refill', callId: null, patientId: pets.mochi!, idempotencyKey: 'h-1', details: { medication: 'drops' } });
    const calls = new CallRepository(t.db, cipher);
    const fromKnown = await calls.open(V, 'live_num_1', '(720) 555-0172');
    const fromUnknown = await calls.open(V, 'live_num_2', '+17205550199');
    const byCall = await queue().create(V, { type: 'callback', callId: fromKnown, patientId: null, idempotencyKey: 'h-2', details: { reason: 'from the number on file' } });
    const stranger = await queue().create(V, { type: 'callback', callId: fromUnknown, patientId: null, idempotencyKey: 'h-3', details: { reason: 'from a number nobody is on' } });
    const rows = (await t.owner.execute(sql`select id, household_hash from tasks where clinic_id = ${V} and id in (${linked.id}, ${byCall.id}, ${stranger.id})`)).rows as { id: string; household_hash: string | null }[];
    expect(Object.fromEntries(rows.map((r) => [r.id, r.household_hash]))).toEqual({ [linked.id]: household, [byCall.id]: household, [stranger.id]: null });
  });

  it('is found by its number (R-1042 or 1042), the owner\'s name, a phone in any format, and a note', async () => {
    const desk = new FrontDeskRepository(t.db, cipher);
    const noted = await queue().create(V, { type: 'callback', callId: null, patientId: pets.mochi!, idempotencyKey: 's-1', details: { reason: 'boarding over the holidays' } });
    await desk.addTaskNote(V, noted.id, 'u_num', 'Left a message with the kennel');
    const find = async (q: string) => (await desk.listTasks(V, { status: 'open', limit: 50, q }, 'u_num')).map((x) => x.id);
    expect(await find(`R-${noted.number}`)).toEqual([noted.id]);
    expect(await find(`r${noted.number}`)).toEqual([noted.id]);
    expect(await find(String(noted.number))).toContain(noted.id);
    expect(await find('Nguyen')).toContain(noted.id); // the owner on file for Mochi
    for (const phone of ['(720) 555-0172', '720-555-0172', '7205550172', '0172']) expect(await find(phone), phone).toContain(noted.id);
    expect(await find('kennel')).toEqual([noted.id]);
    expect(await find('nothing like this')).toEqual([]);
    expect((await desk.listTasks(V, { status: 'open', limit: 50 }, 'u_num')).find((x) => x.id === noted.id)?.number).toBe(noted.number);
  });
});
