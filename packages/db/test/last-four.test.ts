import { RIVERBEND_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, PostgresPatientDirectory, seedRiverbend } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let ids: Record<string, string>;
let callId: string;
const C = RIVERBEND_CLINIC.id;

beforeAll(async () => {
  t = await openTestDatabase();
  ({ patientIds: ids } = await seedRiverbend(t.db, cipher));
  callId = await new CallRepository(t.db, cipher).open(C, 'sess_last_four', null);
});
afterAll(() => t.close());

// The second way to find a profile (2026-11-15): the last four digits of the number on file and the pet's name, by the
// keyed lookup of migration 0042. Exactly one pet in exactly one household, or nothing.
describe('a pet by the last four digits and its name', () => {
  it('finds the one pet, by its name or one that sounds like it, and audits it', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    expect(await dir.findPetByLastFour(C, '0174', 'Luna', callId)).toMatchObject({ status: 'found', patient: { id: ids.luna, firstName: 'Luna', species: 'dog' } });
    expect(await dir.findPetByLastFour(C, '0 1 7 4', 'Loona', callId)).toMatchObject({ status: 'found', patient: { id: ids.luna } });
    const audit = (await t.db.execute(sql`select action, entity_id from audit_logs where clinic_id = ${C} and action = 'patient.identified.by_last_four'`)).rows;
    expect(audit).toContainEqual({ action: 'patient.identified.by_last_four', entity_id: ids.luna });
  });

  it('finds nothing for another pet, other digits, or not four digits', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    expect(await dir.findPetByLastFour(C, '0174', 'Pepper', callId)).toEqual({ status: 'not_found' });
    expect(await dir.findPetByLastFour(C, '0199', 'Luna', callId)).toEqual({ status: 'not_found' });
    expect(await dir.findPetByLastFour(C, '174', 'Luna', callId)).toEqual({ status: 'not_found' });
    // another clinic's lookups are keyed apart
    expect(await dir.findPetByLastFour('clinic_other', '0174', 'Luna', callId)).toEqual({ status: 'not_found' });
  });

  it('picks the pet by its name among the household\'s, and never across two households sharing the last four digits', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    // Linh's number ends 0172 with Biscuit and Mochi
    expect(await dir.findPetByLastFour(C, '0172', 'Mochi', callId)).toMatchObject({ status: 'found', patient: { id: ids.mochi } });
    // another household ending 0172 with its own Biscuit: two households match, so nobody is found
    await dir.create(C, { firstName: 'Biscuit', lastName: 'Marsh', dob: '2020-01-01', phone: '+13035550172', guardianName: 'Robin Marsh', gender: 'male', species: 'dog' });
    expect(await dir.findPetByLastFour(C, '0172', 'Biscuit', callId)).toEqual({ status: 'ambiguous' });
    // the name still tells the households apart when it can
    expect(await dir.findPetByLastFour(C, '0172', 'Mochi', callId)).toMatchObject({ status: 'found', patient: { id: ids.mochi } });
  });
});
