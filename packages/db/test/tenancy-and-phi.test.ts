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
  await new PostgresPatientDirectory(t.db, cipher, 'seed').create(OTHER.id, { firstName: 'Maria', lastName: 'Delgado', dob: '1985-03-04' });
});
afterAll(() => t.close());

describe('tenant isolation', () => {
  it('a clinic cannot read another clinic\'s patients, even with no filter in the query', async () => {
    const rows = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.patients));
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.clinicId === DEMO_CLINIC.id)).toBe(true);
  });

  it('a write tagged with another clinic is refused by the policy', async () => {
    expect(await failure(withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.insert(schema.patients).values({
      clinicId: OTHER.id, lookupHash: 'x', firstNameEnc: 'x', lastNameEnc: 'x', dobEnc: 'x',
    })))).toMatch(/row-level security/);
  });

  it('the application role cannot list organizations or phone numbers, which have no policy', async () => {
    expect(await failure(withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`select id from organizations`)))).toMatch(/permission denied/);
    expect(await failure(withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`select e164 from phone_numbers`)))).toMatch(/permission denied/);
    const own = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`select id from clinics`));
    expect(own.rows).toEqual([{ id: DEMO_CLINIC.id }]);
  });

  it('the same name and DOB in two clinics resolves to each clinic\'s own record', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const here = await dir.findByNameAndDob(DEMO_CLINIC.id, 'Maria Delgado', '1985-03-04');
    const there = await dir.findByNameAndDob(OTHER.id, 'Maria Delgado', '1985-03-04');
    expect(here.status === 'found' && here.patient.id).toBe(ids.maria);
    expect(there.status === 'found' && there.patient.id).not.toBe(ids.maria);
  });
});

describe('seed', () => {
  it('can run twice without creating a second copy of any patient', async () => {
    const again = await seedDemo(t.db, cipher);
    expect(again.patientIds).toEqual(ids);
    const rows = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.patients));
    expect(rows).toHaveLength(4);
  });
});

describe('PHI at rest', () => {
  it('stores names, dates of birth and phone numbers only as ciphertext', async () => {
    const dump = JSON.stringify((await t.db.execute(sql`select * from patients`)).rows);
    for (const plain of ['Maria', 'Delgado', '1985-03-04', '3035550147']) expect(dump).not.toContain(plain);
  });

  it('finds a caller by name and DOB, refuses a near miss, and flags twins as ambiguous', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    expect(await dir.findByNameAndDob(DEMO_CLINIC.id, 'maria delgado', '1985-03-04')).toMatchObject({ status: 'found', patient: { firstName: 'Maria' } });
    expect(await dir.findByNameAndDob(DEMO_CLINIC.id, 'Maria Delgado', '1985-04-03')).toEqual({ status: 'not_found' });
    expect(await dir.findByNameAndDob(DEMO_CLINIC.id, 'Sam Rivera', '1990-07-15')).toEqual({ status: 'ambiguous' });
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
