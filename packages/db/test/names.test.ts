import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPhiCipher, PostgresPatientDirectory, rehashPatientLookups, seedDemo } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let dir: PostgresPatientDirectory;
beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  dir = new PostgresPatientDirectory(t.db, cipher);
  await dir.create(DEMO_CLINIC.id, { firstName: 'Søren', lastName: 'Ødegård', dob: '1979-04-12' });
  await dir.create(DEMO_CLINIC.id, { firstName: 'Łukasz', lastName: 'Wąs', dob: '1991-11-30' });
});
afterAll(() => t.close());

describe('names beyond a to z', () => {
  it.each([
    ['Søren Ødegård', '1979-04-12'], ['Soren Odegard', '1979-04-12'],
    ['Łukasz Wąs', '1991-11-30'], ['Lukasz Was', '1991-11-30'],
  ])('verifies "%s"', async (name, dob) => {
    expect((await dir.findByNameAndDob(DEMO_CLINIC.id, name, dob)).status).toBe('found');
  });

  it('rehashes lookups that were made the old way, and leaves plain names as they were', async () => {
    await t.db.execute(sql`update patients set lookup_hash = 'made-the-old-way' where clinic_id = ${DEMO_CLINIC.id}`);
    expect((await dir.findByNameAndDob(DEMO_CLINIC.id, 'Maria Delgado', '1985-03-04')).status).toBe('not_found');
    const first = await rehashPatientLookups(t.db, cipher);
    expect(first.changed).toBe(first.checked);
    expect((await dir.findByNameAndDob(DEMO_CLINIC.id, 'Maria Delgado', '1985-03-04')).status).toBe('found');
    expect((await dir.findByNameAndDob(DEMO_CLINIC.id, 'Soren Odegard', '1979-04-12')).status).toBe('found');
    expect((await rehashPatientLookups(t.db, cipher)).changed).toBe(0); // a second run changes nothing
  });
});
