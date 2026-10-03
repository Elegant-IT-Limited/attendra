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
  await dir.create(DEMO_CLINIC.id, { firstName: 'Søren', lastName: 'Ødegård', dob: '1979-04-12', phone: '+13035550181' });
  await dir.create(DEMO_CLINIC.id, { firstName: 'Łukasz', lastName: 'Wąs', dob: '1991-11-30', phone: '+13035550182' });
});
afterAll(() => t.close());

describe('names beyond a to z', () => {
  it.each([
    ['Søren Ødegård', '1979-04-12', '303-555-0181'], ['Soren Odegard', '1979-04-12', '(303) 555-0181'],
    ['Łukasz Wąs', '1991-11-30', '3035550182'], ['Lukasz Was', '1991-11-30', '+1 303 555 0182'],
  ])('verifies "%s"', async (name, dob, phone) => {
    expect((await dir.findByIdentity(DEMO_CLINIC.id, name, dob, phone)).status).toBe('found');
  });

  it('rehashes lookups and identities that were made the old way, and leaves the rest as they were', async () => {
    await t.db.execute(sql`update patients set lookup_hash = 'made-the-old-way', identity_hash = null where clinic_id = ${DEMO_CLINIC.id}`);
    expect((await dir.findByIdentity(DEMO_CLINIC.id, 'Maria Delgado', '1985-03-04', '+13035550147')).status).toBe('not_found');
    const first = await rehashPatientLookups(t.db, cipher);
    expect(first.changed).toBe(first.checked);
    expect(first).toMatchObject({ withoutPhone: 0, duplicates: 0 });
    expect((await dir.findByIdentity(DEMO_CLINIC.id, 'Maria Delgado', '1985-03-04', '+13035550147')).status).toBe('found');
    expect((await dir.findByIdentity(DEMO_CLINIC.id, 'Soren Odegard', '1979-04-12', '3035550181')).status).toBe('found');
    expect((await rehashPatientLookups(t.db, cipher)).changed).toBe(0); // a second run changes nothing
  });

  it('counts a patient from before phones were required, and leaves their row alone', async () => {
    // a row as an older version wrote it: no phone (the constraint is NOT VALID, so it may stay)
    await t.db.execute(sql`alter table patients drop constraint patients_phone_required`);
    await t.db.execute(sql`insert into patients (clinic_id, lookup_hash, first_name_enc, last_name_enc, dob_enc) select clinic_id, 'old', first_name_enc, last_name_enc, dob_enc from patients where clinic_id = ${DEMO_CLINIC.id} limit 1`);
    await t.db.execute(sql`alter table patients add constraint patients_phone_required check (phone_enc is not null and phone_hash is not null) not valid`);
    const run = await rehashPatientLookups(t.db, cipher);
    expect(run).toMatchObject({ withoutPhone: 1, changed: 0 });
  });

  it('does not stop when someone added since the upgrade is the same person as a row from before it', async () => {
    // the older row: same person, no identity yet; the newer one holds the identity
    const older = await dir.create(DEMO_CLINIC.id, { firstName: 'Ada', lastName: 'Byron', dob: '1985-12-10', phone: '+13035550186' });
    await t.db.execute(sql`update patients set identity_hash = null, created_at = '2020-01-01' where id = ${older}`);
    const newer = await dir.create(DEMO_CLINIC.id, { firstName: 'Ada', lastName: 'Byron', dob: '1985-12-10', phone: '+13035550186' });
    const run = await rehashPatientLookups(t.db, cipher);
    expect(run.duplicates).toBe(1);
    const held = (await t.db.execute(sql`select id from patients where identity_hash is not null and id in (${older}, ${newer})`)).rows as { id: string }[];
    expect(held).toEqual([{ id: newer }]);
  });
});
