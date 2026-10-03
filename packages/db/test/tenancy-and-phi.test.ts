import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, claimDelivery, createPhiCipher, PostgresPatientDirectory, PostgresTaskQueue, saveClinic, schema, seedDemo, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };
let t: Awaited<ReturnType<typeof openTestDatabase>>;

// Drizzle wraps the driver error; the Postgres message is on the cause.
const failure = (p: Promise<unknown>) => p.then(() => 'no error', (e: { cause?: { message?: string }; message: string }) => e.cause?.message ?? e.message);
let ids: Record<string, string>;

beforeAll(async () => {
  t = await openTestDatabase();
  ({ patientIds: ids } = await seedDemo(t.db, cipher));
  await saveClinic(t.db, 'org_other', OTHER);
  await new PostgresPatientDirectory(t.db, cipher, 'seed').create(OTHER.id, { firstName: 'Maria', lastName: 'Delgado', dob: '1985-03-04', phone: '+13035550147' });
});
afterAll(() => t.close());

describe('tenant isolation', () => {
  it('a clinic cannot read another clinic\'s patients, even with no filter in the query', async () => {
    const rows = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.patients));
    expect(rows.length).toBe(6);
    expect(rows.every((r) => r.clinicId === DEMO_CLINIC.id)).toBe(true);
  });

  it('a write tagged with another clinic is refused by the policy', async () => {
    expect(await failure(withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.insert(schema.patients).values({
      clinicId: OTHER.id, lookupHash: 'x', firstNameEnc: 'x', lastNameEnc: 'x', dobEnc: 'x', phoneEnc: 'x', phoneHash: 'x',
    })))).toMatch(/row-level security/);
  });

  it('the application role cannot list organizations or phone numbers, which have no policy', async () => {
    expect(await failure(withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`select id from organizations`)))).toMatch(/permission denied/);
    expect(await failure(withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`select e164 from phone_numbers`)))).toMatch(/permission denied/);
    const own = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`select id from clinics`));
    expect(own.rows).toEqual([{ id: DEMO_CLINIC.id }]);
  });

  it('the same person in two clinics resolves to each clinic\'s own record', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const here = await dir.findByIdentity(DEMO_CLINIC.id, 'Maria Delgado', '1985-03-04', '+13035550147');
    const there = await dir.findByIdentity(OTHER.id, 'Maria Delgado', '1985-03-04', '+13035550147');
    expect(here.status === 'found' && here.patient.id).toBe(ids.maria);
    expect(there.status === 'found' && there.patient.id).not.toBe(ids.maria);
  });
});

describe('seed', () => {
  it('can run twice without creating a second copy of any patient', async () => {
    const again = await seedDemo(t.db, cipher);
    expect(again.patientIds).toEqual(ids);
    const rows = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.patients));
    expect(rows).toHaveLength(6);
  });
});

describe('PHI at rest', () => {
  it('stores names, dates of birth and phone numbers only as ciphertext', async () => {
    const dump = JSON.stringify((await t.db.execute(sql`select * from patients`)).rows);
    for (const plain of ['Maria', 'Delgado', '1985-03-04', '3035550147']) expect(dump).not.toContain(plain);
  });

  it('finds a patient by name, DOB and phone, refuses a near miss, and tells apart two people who share a name and birthday', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    expect(await dir.findByIdentity(DEMO_CLINIC.id, 'maria delgado', '1985-03-04', '303-555-0147')).toMatchObject({ status: 'found', patient: { firstName: 'Maria', dob: '1985-03-04', isNew: false } });
    expect(await dir.findByIdentity(DEMO_CLINIC.id, 'Maria Delgado', '1985-04-03', '303-555-0147')).toEqual({ status: 'not_found' });
    expect(await dir.findByIdentity(DEMO_CLINIC.id, 'Maria Delgado', '1985-03-04', '303-555-0199')).toEqual({ status: 'not_found' });
    expect(await dir.findByIdentity(DEMO_CLINIC.id, 'Sam Rivera', '1990-07-15', '+13035550171')).toMatchObject({ status: 'found', patient: { id: ids.sam_a } });
    expect(await dir.findByIdentity(DEMO_CLINIC.id, 'Sam Rivera', '1990-07-15', '+13035550172')).toMatchObject({ status: 'found', patient: { id: ids.sam_b } });
    // Maria's children are on her phone: each is found by their own name and birthday
    expect(await dir.findByIdentity(DEMO_CLINIC.id, 'Lucas Delgado', '2019-05-12', '+13035550147')).toMatchObject({ status: 'found', patient: { id: ids.lucas } });
  });

  it('adds a new patient once, and tells the front desk when someone else shares their name and birthday', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const callId = await new CallRepository(t.db, cipher).open(DEMO_CLINIC.id, 'sess_register', null);
    const first = await dir.register(DEMO_CLINIC.id, { firstName: 'Sam', lastName: 'Rivera', dob: '1990-07-15', phone: '+13035550173', gender: 'male', guardianName: null, callId });
    expect(first).toMatchObject({ status: 'created', similar: true, patient: { isNew: true } });
    const again = await dir.register(DEMO_CLINIC.id, { firstName: 'sam', lastName: 'rivera', dob: '1990-07-15', phone: '(303) 555-0173', gender: 'male', guardianName: null, callId });
    expect(again).toMatchObject({ status: 'exists', patient: { id: first.patient.id } });
    const child = await dir.register(DEMO_CLINIC.id, { firstName: 'Mateo', lastName: 'Delgado', dob: '2021-02-03', phone: '+13035550147', gender: 'male', guardianName: 'Maria Delgado', callId });
    expect(child).toMatchObject({ status: 'created', similar: false });
    // the same person cannot be stored twice, whichever path writes them
    expect(await failure(withClinic(t.db, DEMO_CLINIC.id, async (tx) => {
      const [row] = await tx.select().from(schema.patients).where(sql`${schema.patients.id} = ${child.patient.id}`);
      await tx.insert(schema.patients).values({ ...row!, id: undefined });
    }))).toMatch(/patients_identity/);
  });

  it('audits a call record once when it opens and once when it closes, with its counts, and each patient created', async () => {
    const calls = new CallRepository(t.db, cipher);
    const callId = await calls.open(OTHER.id, 'sess_phi_audit', '+13035550199');
    await calls.appendSegment(OTHER.id, callId, { speaker: 'caller', text: 'I need a refill', startMs: 0, endMs: 900 });
    await calls.appendSegment(OTHER.id, callId, { speaker: 'agent', text: 'I can help with that.', startMs: 1000, endMs: 1900 });
    await calls.recordAction(OTHER.id, callId, { tool: 'get_clinic_info', argsRedacted: ['question'], result: { ok: true }, taskRevision: 1 });
    await calls.close(OTHER.id, callId, { reason: 'caller_hangup', voiceSeconds: 12, outcome: 'info', emergency: false });
    const patientId = await new PostgresPatientDirectory(t.db, cipher).create(OTHER.id, { firstName: 'Iris', lastName: 'Novak', dob: '1979-02-11', phone: '+13035550190' });
    const rows = await withClinic(t.db, OTHER.id, (tx) => tx.select().from(schema.auditLogs).orderBy(schema.auditLogs.id));
    // not one row per transcript line or tool step: those would bury the staff rows
    expect(rows.filter((r) => r.callId === callId).map((r) => [r.actor, r.action, r.counts])).toEqual([
      ['system', 'call.opened', null], ['system', 'call.closed', { lines: 2, actions: 1 }],
    ]);
    expect(rows.find((r) => r.action === 'patient.created' && r.entityId === patientId)?.actor).toBe('voice-agent');
  });

  it('audits every successful identification, and the audit log cannot be edited', async () => {
    const audited = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.auditLogs));
    expect(audited.some((a) => a.action === 'patient.identified' && a.entityId === ids.maria)).toBe(true);
    expect(await failure(withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`delete from audit_logs`)))).toMatch(/permission denied/);
  });
});

describe('idempotency', () => {
  it('a retried task creation returns the first task instead of opening a second', async () => {
    const q = new PostgresTaskQueue(t.db, cipher);
    const callId = await new CallRepository(t.db, cipher).open(DEMO_CLINIC.id, 'live_idem', null);
    const input = { type: 'refill' as const, callId, patientId: ids.maria!, idempotencyKey: 'call:live_idem:refill:1', details: { medication: 'lisinopril 10 mg' } };
    const first = await q.create(DEMO_CLINIC.id, input);
    const again = await q.create(DEMO_CLINIC.id, input);
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
  });

  it('a webhook delivery id is handled once', async () => {
    expect(await claimDelivery(t.db, 'wh_1', 'openai')).toBe(true);
    expect(await claimDelivery(t.db, 'wh_1', 'openai')).toBe(false);
  });
});

describe('ciphertext binding', () => {
  it('a value copied into another clinic\'s row does not decrypt there', () => {
    const stored = cipher.encrypt('Maria', 'clinic_demo_maple:patients.first_name');
    expect(cipher.decrypt(stored, 'clinic_demo_maple:patients.first_name')).toBe('Maria');
    expect(() => cipher.decrypt(stored, 'clinic_other:patients.first_name')).toThrow();
  });
});
