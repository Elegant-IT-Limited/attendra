import { starterClinic } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganizationWithClinic, createPhiCipher, formatSharedNumbers, PostgresPatientDirectory, sharedNumbers, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const C = 'clinic_shared_vets';
let t: Awaited<ReturnType<typeof openTestDatabase>>;

// made-up households; every name and number here must stay out of the printout
const NAMES = ['Jordan', 'Avery', 'Sam', 'Alex', 'Kim', 'Dana', 'Ortiz', 'Lee', 'Biscuit', 'Pepper', 'Clover', 'Ziggy', 'Mochi', 'Pickle', 'Rex', 'Tiny'];
const NUMBERS = ['3035550142', '3035550143', '3035550144', '3035550145', '5550142', '5550145', '0142', '0145'];

beforeAll(async () => {
  t = await openTestDatabase();
  const config = starterClinic({ id: C, name: 'Shared Number Vets', timezone: 'America/Denver', industry: 'vet', phone: '+13035550100' });
  await createOrganizationWithClinic(t.db, { id: 'org_shared_vets', name: 'Shared Number Vets', plan: 'trial' }, config);
  const dir = new PostgresPatientDirectory(t.db, cipher);
  const pet = (firstName: string, phone: string, guardianName: string | null) =>
    dir.create(C, { firstName, lastName: 'Avery', dob: '2024-05-01', phone, guardianName, species: 'Dog' });
  // two owner names on one number
  await pet('Biscuit', '+13035550142', 'Jordan Avery');
  await pet('Pepper', '(303) 555-0142', 'Sam Avery');
  // an owner on one pet and none on the other, at a vet clinic
  await pet('Clover', '+13035550143', 'Alex Kim');
  await pet('Ziggy', '303 555 0143', null);
  // the same owner written twice: not reported
  await pet('Mochi', '+13035550144', 'Jordan Lee');
  await pet('Pickle', '+13035550144', 'jordan  LEE');
  // one number under two stored lookups (a record from before the lookups were rebuilt): reported by its last 9 digits
  await pet('Rex', '+13035550145', 'Dana Ortiz');
  const tiny = await pet('Tiny', '+13035550145', 'Dana Ortiz');
  await withClinic(t.db, C, (tx) => tx.execute(sql`update patients set phone_hash = ${cipher.hash(`${C}|13035550145`)} where id = ${tiny}`));
});
afterAll(() => t.close());

describe('the shared-number dry run', () => {
  it('reports two owners on one number, an owner missing on a vet number, and one number under two lookups', async () => {
    const r = await sharedNumbers(t.db, cipher);
    const mine = r.groups.filter((g) => g.clinicId === C).map(({ groupedBy, pets, owners, withoutOwner }) => ({ groupedBy, pets, owners, withoutOwner }));
    expect(mine).toEqual(expect.arrayContaining([
      { groupedBy: 'number', pets: 2, owners: 2, withoutOwner: 0 },
      { groupedBy: 'number', pets: 2, owners: 1, withoutOwner: 1 },
      { groupedBy: 'last 9', pets: 2, owners: 1, withoutOwner: 0 },
    ]));
    expect(mine).toHaveLength(3);
    expect(r.groups.every((g) => g.created.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))).toBe(true);
  });

  it('prints no name, no number and no hash: the only digit runs are dates and counts', async () => {
    const out = formatSharedNumbers(await sharedNumbers(t.db, cipher)).join('\n');
    expect(out).toContain(`clinic ${C} · vet · grouped by number · pets 2 · owners 2 · created `);
    expect(out).toContain('grouped by last 9');
    expect(out).toMatch(/shared numbers: by number 2 groups \(4 pets\) · by last 9 1 groups \(2 pets\)/);
    for (const name of NAMES) expect(out.toLowerCase()).not.toContain(name.toLowerCase());
    for (const n of NUMBERS) expect(out.replace(/\D/g, ' ')).not.toMatch(new RegExp(`(^|\\D)${n}`));
    const withoutDates = out.replace(/\d{4}-\d{2}-\d{2}/g, '');
    expect(withoutDates).not.toMatch(/\d{3,}/);
    expect(withoutDates).not.toMatch(/[0-9a-f]{16,}|[A-Za-z0-9+/_-]{24,}/);
  });

  it('writes nothing, not even an audit row', async () => {
    const count = async () => (await withClinic(t.db, C, (tx) => tx.execute(sql`select (select count(*) from audit_logs)::int + (select count(*) from patients)::int as n`))).rows[0];
    const before = await count();
    await sharedNumbers(t.db, cipher);
    expect(await count()).toEqual(before);
  });
});
