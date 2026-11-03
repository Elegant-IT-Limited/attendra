import { RIVERBEND_CLINIC, starterClinic } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, PostgresPatientDirectory, sameOwnerName, seedRiverbend, withClinic, schema } from '../src';
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

describe('the animals list for vet clinics opened before it came with sign-up', () => {
  it('counts the vet clinics with no list on a dry run, fills them once on apply, and leaves clinics with a list alone', async () => {
    const { createOrganizationWithClinic, seedAnimalLists } = await import('../src/repositories/provisioning');
    // a clinic opened before 2026-11: no list kept, no vet with animals to derive one from
    const old = { ...starterClinic({ id: 'clinic_old_vets', name: 'Old Oak Vets', timezone: 'America/Chicago', industry: 'vet', phone: '+13125550101' }), lists: undefined };
    await createOrganizationWithClinic(t.db, { id: 'org_old_vets', name: 'Old Oak Vets', plan: 'trial' }, old as never);
    const dry = await seedAnimalLists(t.db, { apply: false });
    expect(dry).toMatchObject({ empty: 1, filled: 0 });
    expect(dry.vet).toBeGreaterThanOrEqual(2); // Riverbend, with its own vets' animals, is a vet clinic with a list already
    expect(await seedAnimalLists(t.db, { apply: true })).toMatchObject({ empty: 1, filled: 1 });
    const [row] = (await t.db.execute(sql`select config -> 'lists' -> 'categories' as list, config_version as v from clinics where id = 'clinic_old_vets'`)).rows as { list: string[]; v: number }[];
    expect(row).toEqual({ list: ['Dogs', 'Cats', 'Rabbits', 'Birds', 'Reptiles', 'Small mammals', 'Exotic pets'], v: 2 });
    expect(await seedAnimalLists(t.db, { apply: true })).toMatchObject({ empty: 0, filled: 0 });
  });
});

// a number the caller says is checked by their name before its records are used; the name on file never leaves (2026-11-14)
describe('the owner check on a spoken number', () => {
  it('compares by sound, with accents and case aside, and the same first two letters', () => {
    expect(sameOwnerName('Lính', 'Linh Nguyen')).toBe(true);
    expect(sameOwnerName('linh nguyen', 'Linh')).toBe(true);
    expect(sameOwnerName('Jordon', 'Jordan')).toBe(true);
    expect(sameOwnerName('José', 'Jose Ortiz')).toBe(true);
    expect(sameOwnerName('Carmen', 'Linh Nguyen')).toBe(false);
    expect(sameOwnerName('Ali', 'Al')).toBe(true);
    expect(sameOwnerName('Al', 'El')).toBe(false);
    expect(sameOwnerName('', 'Linh')).toBe(false);
  });

  it('answers with the result only, audits only the result, and asks for a name the number needs', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const callId = await new CallRepository(t.db, cipher).open(C, 'sess_owner_check', null);
    expect(await dir.ownerMatches(C, '+17205550172', 'LINH', callId)).toBe('match');
    expect(await dir.ownerMatches(C, '+17205550172', 'Alex', callId)).toBe('no_match');
    expect(await dir.ownerMatches(C, '+17205550172', null, callId)).toBe('name_needed');
    expect(await dir.ownerMatches(C, '+17205550199', 'Alex', callId)).toBe('no_owner');
    const audit = (await t.db.execute(sql`select action, entity, entity_id from audit_logs where clinic_id = ${C} and call_id = ${callId} and action like 'patient.owner_check%' order by id`)).rows;
    expect(audit).toEqual([
      { action: 'patient.owner_check.match', entity: 'call', entity_id: callId },
      { action: 'patient.owner_check.no_match', entity: 'call', entity_id: callId },
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/linh|nguyen|alex/i);
  });

  it('gives a known caller the household: the owner\'s first name and the pets, audited', async () => {
    const dir = new PostgresPatientDirectory(t.db, cipher);
    const callId = await new CallRepository(t.db, cipher).open(C, 'sess_household', null);
    expect(await dir.householdOnNumber(C, '+17205550172', callId)).toEqual({ owner: 'Linh', names: expect.arrayContaining(['Biscuit', 'Mochi']), more: false });
    expect(await dir.householdOnNumber(C, '+17205550199', callId)).toEqual({ owner: null, names: [], more: false });
    const audit = (await t.db.execute(sql`select count(*)::int as n from audit_logs where call_id = ${callId} and action = 'patient.household.read.call'`)).rows[0] as { n: number };
    expect(audit.n).toBe(1);
  });
});
