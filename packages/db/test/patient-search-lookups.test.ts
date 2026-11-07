import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPhiCipher, ownerNameMatches, ownerWordKey, PatientRecords, phoneSuffixKey, PostgresPatientDirectory, readRequestNumber, readQuery, rehashPatientLookups, sealPatient, seedDemo } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const C = DEMO_CLINIC.id;
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let ids: Record<string, string>;

const lookupsOf = async (id: string) => (await t.db.execute(sql`select owner_words_hash, phone_suffix_hash from patients where id = ${id}`)).rows[0] as { owner_words_hash: string[] | null; phone_suffix_hash: string | null };
const wordHash = (w: string) => cipher.hash(ownerWordKey(C, w));

beforeAll(async () => {
  t = await openTestDatabase();
  ids = (await seedDemo(t.db, cipher)).patientIds;
});
afterAll(() => t.close());

describe('the search lookups of migration 0042', () => {
  it('a created patient carries the keyed hash of each word of its owner\'s and its own name, and of the phone\'s last four digits', async () => {
    const directory = new PostgresPatientDirectory(t.db, cipher);
    const id = await directory.create(C, { firstName: 'Waffles', lastName: 'Ferreira', dob: '2021-04-09', phone: '+17205550162', guardianName: 'Daniel Ferreira', species: 'dog' });
    const row = await lookupsOf(id);
    expect(row.owner_words_hash!.sort()).toEqual(['daniel', 'ferreira', 'waffles'].map(wordHash).sort()); // "ferreira" once, though it is both names
    expect(row.phone_suffix_hash).toBe(cipher.hash(phoneSuffixKey(C, '0162')));
    // nothing readable is stored
    expect(JSON.stringify(row)).not.toMatch(/waffles|daniel|ferreira|0162/i);
  });

  it('the rehash fills them for a row stored without them, counts it once, and leaves it alone the second time', async () => {
    // a row the way it was stored before 0042: the same ciphertext and hashes, no search lookups
    const older = sealPatient(cipher, C, { firstName: 'Pretzel', lastName: 'Okonkwo', dob: '2020-01-15', phone: '+17205550181', guardianName: 'Amara Okonkwo' });
    const [{ id }] = (await t.db.execute(sql`insert into patients (clinic_id, lookup_hash, identity_hash, first_name_enc, last_name_enc, dob_enc, phone_enc, phone_hash, guardian_name_enc)
      values (${C}, ${older.lookupHash}, ${older.identityHash}, ${older.firstNameEnc}, ${older.lastNameEnc}, ${older.dobEnc}, ${older.phoneEnc}, ${older.phoneHash}, ${older.guardianNameEnc}) returning id`)).rows as [{ id: string }];
    expect(await lookupsOf(id)).toEqual({ owner_words_hash: null, phone_suffix_hash: null });
    const first = await rehashPatientLookups(t.db, cipher, { apply: true });
    expect(first.searchable).toBe(1);
    expect(first.changed).toBe(1);
    expect((await lookupsOf(id)).owner_words_hash!.sort()).toEqual(['amara', 'okonkwo', 'pretzel'].map(wordHash).sort());
    expect((await lookupsOf(id)).phone_suffix_hash).toBe(cipher.hash(phoneSuffixKey(C, '+17205550181')));
    expect(await rehashPatientLookups(t.db, cipher, { apply: true })).toMatchObject({ searchable: 0, changed: 0 });
  });
});

describe('reading a search box for a request number', () => {
  it('reads a number written as one, or digits alone, and never a whole phone', () => {
    expect(readQuery('R-1042')).toEqual({ kind: 'request', number: 1042 });
    expect(readQuery('r 1042')).toEqual({ kind: 'request', number: 1042 });
    expect(readQuery('#1042')).toEqual({ kind: 'request', number: 1042 });
    expect(readQuery('1042')).toEqual({ kind: 'phone', digits: '1042' }); // digits alone are a phone first
    expect(readRequestNumber('1042')).toBe(1042);
    expect(readRequestNumber('R-1042')).toBe(1042);
    expect(readRequestNumber('7205550162')).toBeNull();
    expect(readRequestNumber('555-0162')).toBeNull();
    expect(readRequestNumber('rex')).toBeNull();
  });

  it('matches an owner\'s name by the start of a word, in any order, or as it sounds', () => {
    expect(ownerNameMatches(['dan'], 'Daniel Ferreira')).toBe(true);
    expect(ownerNameMatches(['ferreira', 'daniel'], 'Daniel Ferreira')).toBe(true);
    expect(ownerNameMatches(['danial'], 'Daniel Ferreira')).toBe(true); // one letter off, the same first sound
    expect(ownerNameMatches(['ronald'], 'Daniel Ferreira')).toBe(false);
    expect(ownerNameMatches(['dan'], null)).toBe(false);
  });
});

describe('finding a record by its keys alone', () => {
  // no scan of the newest records (the default since migration 0049): everything a search finds, it found by a key
  const capped = () => new PatientRecords(t.db, cipher);

  it('by the owner\'s name, through the word hashes', async () => {
    const found = (await capped().search(C, 'maria', 'u_ana'))!;
    expect(found.patients.map((p) => [p.firstName, p.matchedOn])).toEqual([['Maria', 'name'], ['Lucas', 'owner'], ['Sofia', 'owner']]);
  });

  it('by the last four digits of the phone, through the suffix hash', async () => {
    const found = (await capped().search(C, '0147', 'u_ana'))!;
    expect(found.patients.map((p) => p.firstName).sort()).toEqual(['Lucas', 'Maria', 'Sofia']); // the Delgados share one phone
    expect(found.patients.every((p) => p.matchedOn === 'phone')).toBe(true);
  });

  it('by a request number, written as one or as digits alone', async () => {
    await t.db.execute(sql`insert into tasks (clinic_id, type, patient_id, details_enc, idempotency_key, number) values (${C}, 'callback', ${ids.james}, 'x', 'search-1042', 1042)`);
    for (const q of ['R-1042', '1042']) {
      const found = (await capped().search(C, q, 'u_ana'))!;
      expect(found.patients.map((p) => [p.firstName, p.matchedOn]), q).toEqual([['James', 'request']]);
    }
    expect((await capped().search(C, 'R-1043', 'u_ana'))!.patients).toEqual([]);
  });
});
