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

// the number is the household (2026-11): a pet is found by the number it is on and its name as the caller says it
describe('pets at a veterinary clinic', () => {
  it('finds a pet by the number and its name, with the kind of animal and its owner, and audits it', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const found = await dir.findPet(C, 'Mochi', '(720) 555-0172');
    expect(found).toMatchObject({ status: 'found', patient: { id: ids.mochi, firstName: 'Mochi', species: 'cat', guardianName: 'Linh Nguyen' } });
    const audit = (await t.db.execute(sql`select action, entity_id from audit_logs where clinic_id = ${C} and action = 'patient.identified.by_number'`)).rows;
    expect(audit).toContainEqual({ action: 'patient.identified.by_number', entity_id: ids.mochi });
  });

  it('finds the pet by a name that sounds like its own, and gives the same answer for a wrong pet and a wrong phone', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    expect(await dir.findPet(C, 'Moochi', '+17205550172')).toMatchObject({ status: 'found', patient: { id: ids.mochi } });
    expect(await dir.findPet(C, 'mochi', '+17205550172')).toMatchObject({ status: 'found', patient: { id: ids.mochi } });
    expect(await dir.findPet(C, 'Pepper', '+17205550172')).toEqual({ status: 'not_found' });
    expect(await dir.findPet(C, 'Mochi', '+17205550199')).toEqual({ status: 'not_found' });
  });

  it('names the number\'s owner, the first registered with it, whatever name a later pet was added under, and audits the read', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const callId = await new CallRepository(t.db, cipher).open(C, 'sess_name', null);
    await dir.register(C, { firstName: 'Rex', lastName: 'Okafor', dob: '2025-01-01', gender: 'male', phone: '+17205550181', guardianName: 'Chidi Okafor', callId, species: 'Dog' });
    await dir.register(C, { firstName: 'Tiny', lastName: 'Okafor', dob: '2025-02-01', gender: 'female', phone: '+17205550181', guardianName: 'chidi', callId, species: 'Cat' });
    expect(await dir.nameOnFile(C, '(720) 555-0181', callId)).toBe('Chidi');
    // a pet added under the number with another name joins the number's owner: one number, one owner
    const bolt = await dir.register(C, { firstName: 'Bolt', lastName: 'Reyes', dob: '2025-03-01', gender: 'male', phone: '+17205550181', guardianName: 'Ana Reyes', callId, species: 'Dog' });
    expect(bolt).toMatchObject({ status: 'created', patient: { firstName: 'Bolt', guardianName: 'Chidi Okafor' } });
    expect(await dir.nameOnFile(C, '+17205550181', callId)).toBe('Chidi');
    expect(await dir.nameOnFile(C, '+17205550128', callId)).toBeNull();
    expect(await dir.household(C, '+17205550181')).toEqual({ owner: 'Chidi Okafor', pets: ['Rex', 'Tiny', 'Bolt'] });
    const audit = (await t.db.execute(sql`select count(*)::int as n from audit_logs where clinic_id = ${C} and action = 'patient.name_on_file.read' and call_id = ${callId}`)).rows;
    expect(audit).toEqual([{ n: 2 }]);
  });

  it('lists the pets on a number, the household, at most three with more for the rest, and audits the read', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const callId = await new CallRepository(t.db, cipher).open(C, 'sess_pets', null);
    expect(await dir.petsOnNumber(C, '+17205550172', callId)).toEqual({ names: ['Biscuit', 'Mochi'], more: false });
    expect(await dir.petsOnNumber(C, '+17205550128', callId)).toEqual({ names: [], more: false });
    const audit = (await t.db.execute(sql`select count(*)::int as n from audit_logs where clinic_id = ${C} and action = 'patient.pets_on_number.read' and call_id = ${callId}`)).rows;
    expect(audit).toEqual([{ n: 1 }]);
  });

  it('adds a new pet with its owner as the guardian and keeps the kind of animal encrypted', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const callId = await new CallRepository(t.db, cipher).open(C, 'sess_pet', null);
    const added = await dir.register(C, { firstName: 'Ziggy', lastName: 'Patel', dob: '2026-02-16', gender: 'male', phone: '+17205550190', guardianName: 'Ava Patel', callId, species: 'Dog' });
    expect(added).toMatchObject({ status: 'created', patient: { firstName: 'Ziggy', species: 'dog', isNew: true, guardianName: 'Ava Patel' } });
    const [row] = await withClinic(t.db, C, (tx) => tx.select().from(schema.patients).where(sql`${schema.patients.phoneHash} is not null and ${schema.patients.speciesEnc} is not null and ${schema.patients.id} = ${added.status === 'created' ? added.patient.id : ''}`));
    expect(row!.speciesEnc).not.toContain('dog');
    expect(await dir.findPet(C, 'Ziggy', '+17205550190')).toMatchObject({ status: 'found' });
  });

  it('sends two pets whose names sound alike on one number to staff', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher, 'seed');
    await dir.create(C, { firstName: 'Moochi', lastName: 'Nguyen', dob: '2024-01-01', phone: '+17205550172', guardianName: 'Linh Nguyen', gender: 'male', species: 'cat' });
    // the exact name still wins over a sound-alike; two that only sound alike cannot be told apart here
    expect(await new PostgresPatientDirectory(t.db, cipher).findPet(C, 'Mochi', '+17205550172')).toMatchObject({ status: 'found', patient: { id: ids.mochi } });
    expect(await new PostgresPatientDirectory(t.db, cipher).findPet(C, 'Mooochi', '+17205550172')).toEqual({ status: 'ambiguous' });
  });
});

describe('one number, one owner: unifying records made before the rule', () => {
  it('counts the numbers with more than one owner name on a dry run, moves every pet to the first owner on apply, and is quiet the second time', async () => {
    const { unifyHouseholds } = await import('../src/repositories/patients');
    const dir = new PostgresPatientDirectory(t.db, cipher, 'seed');
    // two names on one number, as a family number registered before the rule; another number with one owner spelled two ways
    const shared = '+17205550195';
    await dir.create(C, { firstName: 'Olive', lastName: 'Park', dob: '2020-01-01', phone: shared, guardianName: 'Noor Park', gender: 'female', species: 'dog' });
    await dir.create(C, { firstName: 'Fig', lastName: 'Park', dob: '2021-01-01', phone: shared, guardianName: 'Sam Park', gender: 'male', species: 'cat' });
    await dir.create(C, { firstName: 'Plum', lastName: 'Park', dob: '2022-01-01', phone: shared, guardianName: 'noor park', gender: 'female', species: 'cat' });
    const dry = await unifyHouseholds(t.db, cipher, { apply: false });
    expect(dry).toMatchObject({ numbers: 1, pets: 1 });
    expect(await dir.household(C, shared)).toEqual({ owner: 'Noor Park', pets: ['Olive', 'Fig', 'Plum'] });
    expect((await dir.findPet(C, 'Fig', shared))).toMatchObject({ status: 'found', patient: { guardianName: 'Sam Park' } });
    const applied = await unifyHouseholds(t.db, cipher, { apply: true });
    expect(applied).toMatchObject({ numbers: 1, pets: 1 });
    expect((await dir.findPet(C, 'Fig', shared))).toMatchObject({ status: 'found', patient: { guardianName: 'Noor Park' } });
    expect(await unifyHouseholds(t.db, cipher, { apply: true })).toMatchObject({ numbers: 0, pets: 0 });
    const audit = (await t.db.execute(sql`select count(*)::int as n from audit_logs where clinic_id = ${C} and action = 'patient.owner.unified'`)).rows;
    expect(audit).toEqual([{ n: 1 }]);
  });
});
