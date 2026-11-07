import { RIVERBEND_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPhiCipher, normalisePhones, phiContext, PostgresPatientDirectory, PostgresTaskQueue, seedRiverbend, withClinic, schema } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
const C = RIVERBEND_CLINIC.id;

beforeAll(async () => {
  t = await openTestDatabase();
  await seedRiverbend(t.db, cipher);
});
afterAll(() => t.close());

const storedPhones = async () => withClinic(t.db, C, async (tx) =>
  (await tx.select({ phoneEnc: schema.patients.phoneEnc }).from(schema.patients).where(sql`${schema.patients.clinicId} = ${C}`))
    .map((r) => (r.phoneEnc ? cipher.decrypt(r.phoneEnc, phiContext(C, 'patients.phone')) : null)));

describe('one number, one form: the stored-phone clean-up', () => {
  it('counts on a dry run, writes E.164 on apply, keeps every record findable, and is quiet the second time', async () => {
    const before = await normalisePhones(t.db, cipher, { apply: false });
    const dir = new PostgresPatientDirectory(t.db, cipher, 'seed');
    // the same household number typed two ways before the rule, and a number too short to read whole
    await dir.create(C, { firstName: 'Olive', lastName: 'Reyes', dob: '2020-01-01', phone: '(720) 555-0141', guardianName: 'Noor Reyes', gender: 'female', species: 'dog' });
    await dir.create(C, { firstName: 'Fig', lastName: 'Reyes', dob: '2021-01-01', phone: '+17205550141', guardianName: 'Noor Reyes', gender: 'male', species: 'cat' });
    await dir.create(C, { firstName: 'Plum', lastName: 'Shaw', dob: '2022-01-01', phone: '1 720 555 0142', guardianName: 'Kit Shaw', gender: 'female', species: 'cat' });
    await dir.create(C, { firstName: 'Bean', lastName: 'Ortiz', dob: '2022-01-01', phone: '555-0143', guardianName: 'Ari Ortiz', gender: 'male', species: 'dog' });
    await new PostgresTaskQueue(t.db, cipher, 'seed').create(C, { type: 'callback', callId: null, patientId: null, idempotencyKey: 'manual:phones', details: { reason: 'Call back', callback_number: '720.555.0144' } });

    const dry = await normalisePhones(t.db, cipher, { apply: false });
    expect(dry.records - before.records).toBe(2);
    expect(dry.requests - before.requests).toBe(1);
    expect(dry.storedTwice - before.storedTwice).toBe(1);
    expect(dry.unreadable - before.unreadable).toBe(1);
    expect(await storedPhones()).toContain('(720) 555-0141');

    const applied = await normalisePhones(t.db, cipher, { apply: true });
    expect(applied.records).toBe(dry.records);
    const phones = await storedPhones();
    expect(phones).not.toContain('(720) 555-0141');
    expect(phones).toContain('+17205550142');
    expect(phones).toContain('555-0143');
    // the keyed lookups did not change: every form still finds the household
    for (const said of ['7205550141', '+1 (720) 555-0141', '1 720 555 0141']) expect(await dir.household(C, said)).toMatchObject({ pets: ['Olive', 'Fig'] });

    const again = await normalisePhones(t.db, cipher, { apply: true });
    expect(again).toMatchObject({ records: 0, requests: 0, settings: 0, storedTwice: 0 });
    const audit = (await t.owner.execute(sql`select count(*)::int as n from audit_logs where clinic_id = ${C} and action = 'patient.phone.normalised'`)).rows;
    expect(audit).toEqual([{ n: dry.records }]);
  });
});
