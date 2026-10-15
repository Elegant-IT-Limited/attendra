import { RIVERBEND_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, PostgresPatientDirectory, seedRiverbend, withClinic, schema } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let ids: Record<string, string>;
const C = RIVERBEND_CLINIC.id;

beforeAll(async () => {
  t = await openTestDatabase();
  ({ patientIds: ids } = await seedRiverbend(t.db, cipher));
});
afterAll(() => t.close());

describe('pets at a veterinary clinic', () => {
  it('finds a pet by its owner\'s name, its own name and the phone, with the kind of animal, and audits it', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const found = await dir.findPet(C, 'linh nguyen', 'Mochi', '(720) 555-0172');
    expect(found).toMatchObject({ status: 'found', patient: { id: ids.mochi, firstName: 'Mochi', species: 'cat' } });
    const audit = (await t.db.execute(sql`select action, entity_id from audit_logs where clinic_id = ${C} and action = 'patient.identified'`)).rows;
    expect(audit).toContainEqual({ action: 'patient.identified', entity_id: ids.mochi });
  });

  it('gives the same answer for a wrong owner, a wrong pet and a wrong phone', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    expect(await dir.findPet(C, 'Daniel Brooks', 'Mochi', '+17205550172')).toEqual({ status: 'not_found' });
    expect(await dir.findPet(C, 'Linh Nguyen', 'Pepper', '+17205550172')).toEqual({ status: 'not_found' });
    expect(await dir.findPet(C, 'Linh Nguyen', 'Mochi', '+17205550199')).toEqual({ status: 'not_found' });
  });

  it('adds a new pet with its owner as the guardian and keeps the kind of animal encrypted', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const callId = await new CallRepository(t.db, cipher).open(C, 'sess_pet', null);
    const added = await dir.register(C, { firstName: 'Ziggy', lastName: 'Patel', dob: '2026-02-16', gender: 'male', phone: '+17205550190', guardianName: 'Ava Patel', callId, species: 'Dog' });
    expect(added).toMatchObject({ status: 'created', patient: { firstName: 'Ziggy', species: 'dog', isNew: true } });
    const [row] = await withClinic(t.db, C, (tx) => tx.select().from(schema.patients).where(sql`${schema.patients.phoneHash} is not null and ${schema.patients.speciesEnc} is not null and ${schema.patients.createdByCallId} = ${callId}`));
    expect(row!.speciesEnc).not.toContain('dog');
    expect(await dir.findPet(C, 'Ava Patel', 'Ziggy', '+17205550190')).toMatchObject({ status: 'found' });
  });

  it('sends two pets with the same name on one number to staff', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher, 'seed');
    await dir.create(C, { firstName: 'Mochi', lastName: 'Nguyen', dob: '2024-01-01', phone: '+17205550172', guardianName: 'Linh Nguyen', gender: 'male', species: 'cat' });
    expect(await new PostgresPatientDirectory(t.db, cipher).findPet(C, 'Linh Nguyen', 'Mochi', '+17205550172')).toEqual({ status: 'ambiguous' });
  });
});
