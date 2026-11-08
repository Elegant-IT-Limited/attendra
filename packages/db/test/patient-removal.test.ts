import { RIVERBEND_CLINIC, zonedInstant } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, DELETED_DOB, PatientRecords, PatientRemoval, PostgresPatientDirectory, PostgresTaskQueue, phiContext, saveClinic, schema, seedRiverbend, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const C = RIVERBEND_CLINIC.id;
const OTHER = { ...RIVERBEND_CLINIC, id: 'clinic_other_vets', name: 'Other Vets', phoneNumbers: ['+17205550121'] };
const tz = RIVERBEND_CLINIC.timezone;
const NOW = zonedInstant('2026-10-05', '12:00', tz);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let removal: PatientRemoval;
let records: PatientRecords;
let dir: PostgresPatientDirectory;

const q = async <T>(query: ReturnType<typeof sql>) => (await t.owner.execute(query)).rows as T[];
const visit = (patientId: string, start: Date, extra: Partial<typeof schema.appointments.$inferInsert> = {}) => withClinic(t.db, C, async (tx) => (await tx.insert(schema.appointments).values({
  clinicId: C, patientId, providerId: 'prov_ruiz', visitTypeId: 'vt_sick', startsAt: start, endsAt: new Date(start.getTime() + 20 * 60_000),
  idempotencyKey: crypto.randomUUID(), createdByUserId: 'u_ana', ...extra,
}).returning({ id: schema.appointments.id }))[0]!.id);
const pet = (firstName: string, phone: string, guardianName: string, dob = '2020-03-01') => dir.create(C, { firstName, lastName: guardianName.split(' ')[1] ?? '', dob, phone, guardianName, species: 'dog' });
const searchIds = async (query: string) => ((await records.search(C, query, 'u_ana', NOW))?.patients ?? []).map((p) => p.id);

beforeAll(async () => {
  t = await openTestDatabase();
  await seedRiverbend(t.db, cipher);
  await saveClinic(t.db, 'org_other_vets', OTHER);
  removal = new PatientRemoval(t.db, cipher);
  records = new PatientRecords(t.db, cipher);
  dir = new PostgresPatientDirectory(t.db, cipher, 'seed');
});
afterAll(() => t.close());

describe('deleting a pet\'s record', () => {
  it('previews in counts, then removes every personal detail and search key, cancels what is to come and keeps the past visits for the counts', async () => {
    const id = await pet('Pip', '+17205550161', 'Rory Vale');
    await t.owner.execute(sql`update patients set sms_consent_at = now(), sms_consent_source = 'staff', custom_enc = ${cipher.encrypt('{"chip":"985"}', phiContext(C, 'patients.custom'))} where id = ${id}`);
    const past = await visit(id, zonedInstant('2026-09-28', '10:00', tz), { status: 'completed', noteEnc: cipher.encrypt('limps on the left', phiContext(C, 'appointments.note')) });
    const ahead = await visit(id, zonedInstant('2026-10-08', '10:00', tz));
    const callId = await new CallRepository(t.db, cipher).open(C, 'removal_call_1', '+17205550161');
    await t.owner.execute(sql`update calls set patient_id = ${id} where id = ${callId}`);
    const task = await new PostgresTaskQueue(t.db, cipher).create(C, { type: 'callback', callId, patientId: id, idempotencyKey: 'removal-task-1', details: { reason: 'ask about Pip', callback_number: '+17205550161' } });
    await t.owner.execute(sql`insert into task_notes (clinic_id, task_id, author_user_id, body_enc) values (${C}, ${task.id}, 'u_ana', ${cipher.encrypt('called, no answer', phiContext(C, 'task_notes.body'))})`);
    expect(await searchIds('Pip')).toContain(id);

    expect(await removal.previewDelete(C, id, 'pet', NOW)).toEqual({ records: 1, upcomingCancelled: 1, visitsKept: 1, requests: 1, callsUnlinked: 1 });
    expect((await q<{ n: number }>(sql`select count(*)::int as n from appointments where patient_id = ${id} and status = 'booked'`))[0]!.n).toBe(1); // a preview changes nothing

    const done = await removal.delete(C, id, 'pet', 'u_olga', NOW);
    expect(done).toEqual({ counts: { records: 1, upcomingCancelled: 1, visitsKept: 1, requests: 1, callsUnlinked: 1 }, cancelled: [ahead] });
    const [row] = await q<Record<string, unknown>>(sql`select * from patients where id = ${id}`);
    const ctx = (col: string) => phiContext(C, `patients.${col}`);
    expect(cipher.decrypt(row!.first_name_enc as string, ctx('first_name'))).toBe('Deleted');
    expect(cipher.decrypt(row!.dob_enc as string, ctx('dob'))).toBe(DELETED_DOB);
    expect(row).toMatchObject({ phone_enc: null, phone_hash: null, identity_hash: null, guardian_name_enc: null, species_enc: null, custom_enc: null, owner_words_hash: null, phone_suffix_hash: null, sms_consent_at: null, deleted_by: 'u_olga' });
    expect(row!.deleted_at).not.toBeNull();
    expect(await q(sql`select key from patient_search_keys where patient_id = ${id}`)).toEqual([]);
    expect(await searchIds('Pip')).not.toContain(id);
    expect(await searchIds('0161')).not.toContain(id);
    expect(await q(sql`select id, status, note_enc from appointments where patient_id = ${id} order by starts_at`)).toEqual([
      { id: past, status: 'completed', note_enc: null }, { id: ahead, status: 'cancelled', note_enc: null },
    ]);
    const [t1] = await q<{ details_enc: string; status: string; household_hash: string | null }>(sql`select details_enc, status, household_hash from tasks where id = ${task.id}`);
    expect(cipher.decrypt(t1!.details_enc, phiContext(C, 'tasks.details'))).toBe('{}');
    expect(t1).toMatchObject({ status: 'done', household_hash: null });
    expect(await q(sql`select id from task_notes where task_id = ${task.id}`)).toEqual([]);
    expect(await q(sql`select patient_id from calls where id = ${callId}`)).toEqual([{ patient_id: null }]);
    // gone from the lists, the profile and booking; the audit says who, which and how many, never what
    expect(await records.profile(C, id, 'u_ana')).toBeNull();
    expect((await records.newest(C, 'u_ana')).map((p) => p.id)).not.toContain(id);
    expect(await q(sql`select actor, counts from audit_logs where action = 'patient.deleted' and entity_id = ${id}`)).toEqual([{ actor: 'user:u_olga', counts: null }]);
    // and twice is not found
    expect(await removal.delete(C, id, 'pet', 'u_olga', NOW)).toBeNull();
  });

  it('a household: every pet on the number', async () => {
    const a = await pet('Juno', '+17205550162', 'Kit Moss');
    const b = await pet('Ollie', '+17205550162', 'Kit Moss', '2021-01-01');
    const other = await pet('Ollie', '+17205550163', 'Ada Lark', '2021-01-01');
    expect((await removal.previewDelete(C, a, 'household', NOW))!.records).toBe(2);
    await removal.delete(C, a, 'household', 'u_olga', NOW);
    expect((await q<{ id: string }>(sql`select id from patients where deleted_at is not null and id in (${a}, ${b}, ${other})`)).map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(await q(sql`select counts from audit_logs where action = 'patient.deleted' and entity_id = ${b}`)).toEqual([{ counts: { household: 2 } }]);
  });

  it('never reaches another clinic\'s record', async () => {
    const theirs = await dir.create(OTHER.id, { firstName: 'Nova', lastName: 'Reed', dob: '2019-01-01', phone: '+17205550164', guardianName: 'Ivy Reed' });
    expect(await removal.previewDelete(C, theirs, 'pet', NOW)).toBeNull();
    expect(await removal.delete(C, theirs, 'pet', 'u_olga', NOW)).toBeNull();
    expect(await removal.previewMerge(C, 'pet', theirs, await pet('Zed', '+17205550165', 'Bo Kerr'))).toEqual({ problem: 'not_found' });
    expect(await q(sql`select deleted_at from patients where id = ${theirs}`)).toEqual([{ deleted_at: null }]);
  });
});

describe('merging records', () => {
  it('the same pet twice: its visits, calls, requests and texts move to the record kept, gaps are filled, the other goes', async () => {
    const keep = await pet('Mabel', '+17205550166', 'Lou Park');
    const dupe = await pet('Mable', '+17205550166', 'Lou Park', '2020-03-02');
    await t.owner.execute(sql`update patients set custom_enc = ${cipher.encrypt('{"chip":"123"}', phiContext(C, 'patients.custom'))}, sms_consent_at = now(), sms_consent_source = 'call' where id = ${dupe}`);
    const v = await visit(dupe, zonedInstant('2026-10-09', '10:00', tz));
    const callId = await new CallRepository(t.db, cipher).open(C, 'removal_call_2', '+17205550166');
    await t.owner.execute(sql`update calls set patient_id = ${dupe} where id = ${callId}`);
    await new PostgresTaskQueue(t.db, cipher).create(C, { type: 'refill', callId, patientId: dupe, idempotencyKey: 'removal-task-2', details: { medication: 'x' } });
    expect(await removal.previewMerge(C, 'pet', keep, dupe)).toEqual({ records: 1, duplicates: 0, appointments: 1, calls: 1, requests: 1, texts: 0 });
    expect(await removal.merge(C, 'pet', keep, dupe, 'u_olga', true)).toMatchObject({ records: 1, appointments: 1 });
    expect(await q(sql`select patient_id from appointments where id = ${v}`)).toEqual([{ patient_id: keep }]);
    expect(await q(sql`select patient_id from calls where id = ${callId}`)).toEqual([{ patient_id: keep }]);
    expect(await q(sql`select id from patients where id = ${dupe}`)).toEqual([]);
    expect(await q(sql`select key from patient_search_keys where patient_id = ${dupe}`)).toEqual([]);
    const card = (await records.profile(C, keep, 'u_ana'))!;
    expect(card.customFields).toEqual({ chip: '123' });
    expect(card.textsOk).toBe(true);
    expect(await q(sql`select action, entity_id from audit_logs where action like 'patient.merged%' and entity_id in (${keep}, ${dupe}) order by id`)).toEqual([
      { action: 'patient.merged', entity_id: keep }, { action: 'patient.merged_away', entity_id: dupe },
    ]);
    expect(await removal.merge(C, 'pet', keep, keep, 'u_olga', true)).toEqual({ problem: 'same_record' });
  });

  it('one owner on two numbers: every pet of the other number joins the number and owner kept, found by its new number, and a pet on both becomes one', async () => {
    const rex = await pet('Rex', '+17205550167', 'Dana Holt');
    const old = await pet('Rex', '+17205550168', 'Dana Hlt'); // the same dog, under a second number, the owner's name mistyped
    const fern = await pet('Fern', '+17205550168', 'Dana Hlt', '2022-06-01');
    const oldVisit = await visit(old, zonedInstant('2026-10-12', '10:00', tz));
    const task = await new PostgresTaskQueue(t.db, cipher).create(C, { type: 'callback', callId: null, patientId: fern, idempotencyKey: 'removal-task-3', details: { reason: 'x' } });
    expect(await removal.previewMerge(C, 'household', rex, fern, true)).toEqual({ records: 2, duplicates: 1, appointments: 1, calls: 0, requests: 1, texts: 0 });
    expect(await removal.previewMerge(C, 'household', rex, rex)).toEqual({ problem: 'same_record' });
    expect(await removal.previewMerge(C, 'household', old, fern)).toEqual({ problem: 'same_household' });
    await removal.merge(C, 'household', rex, fern, 'u_olga', true);
    // the old Rex became the kept Rex; Fern is on the kept number, under the kept owner
    expect(await q(sql`select id from patients where id = ${old}`)).toEqual([]);
    expect(await q(sql`select patient_id from appointments where id = ${oldVisit}`)).toEqual([{ patient_id: rex }]);
    const fernCard = (await records.profile(C, fern, 'u_ana'))!;
    expect(fernCard).toMatchObject({ phone: '+17205550167', guardianName: 'Dana Holt', firstName: 'Fern', lastName: 'Holt' });
    expect(fernCard.household.map((h) => h.id)).toEqual([rex]);
    expect(await searchIds('0167')).toEqual(expect.arrayContaining([rex, fern]));
    expect(await searchIds('0168')).not.toContain(fern);
    const [taskRow] = await q<{ household_hash: string }>(sql`select household_hash from tasks where id = ${task.id}`);
    const [rexRow] = await q<{ phone_hash: string }>(sql`select phone_hash from patients where id = ${rex}`);
    expect(taskRow!.household_hash).toBe(rexRow!.phone_hash);
    const found = await dir.findPet(C, 'Fern', '+17205550167');
    expect(found).toMatchObject({ status: 'found', patient: { id: fern } });
    expect(await q(sql`select action, counts from audit_logs where action = 'patient.household.merged' and entity_id = ${rex}`)).toEqual([
      { action: 'patient.household.merged', counts: { records: 2, duplicates: 1, appointments: 1, calls: 0, requests: 1, texts: 0 } },
    ]);
  });
});
