import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CallRepository, createPhiCipher, FrontDeskRepository, namePrefixKey, ownerWordKey, PatientRecords, phiContext, PostgresPatientDirectory, PostgresTaskQueue, purgeCallRecords,
  rehashCallLookups, rehashPatientLookups, saveClinic, sealPatient, searchHash, TASK_SEARCH_SCAN,
} from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

/**
 * The search keys of v0.10: the first letters, sounds, birthdays and digit runs every search reads instead of
 * decrypting the newest thousands of records on each keystroke. Made-up names and 555-01xx numbers only.
 */
const cipher = createPhiCipher(TEST_DATA_KEY);
const C = 'clinic_keys';
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let records: PatientRecords;
let desk: FrontDeskRepository;
const pet = { biscuit: '', bishop: '', ma: '' };

const keysOf = async (id: string) => ((await t.owner.execute(sql`select key from patient_search_keys where patient_id = ${id} order by key`)).rows as { key: string }[]).map((r) => r.key);
const callKeysOf = async (id: string) => ((await t.owner.execute(sql`select key from call_search_keys where call_id = ${id}`)).rows as { key: string }[]).map((r) => r.key);
const names = async (q: string) => (await records.search(C, q, 'u_kim'))!.patients.map((p) => [p.firstName, p.matchedOn]);
const audit = async (action: string) => (await t.owner.execute(sql`select entity_id from audit_logs where clinic_id = ${C} and action = ${action} order by id`)).rows.map((r: unknown) => (r as { entity_id: string }).entity_id);

beforeAll(async () => {
  t = await openTestDatabase();
  await saveClinic(t.db, 'org_keys', { ...DEMO_CLINIC, id: C, name: 'Keys Clinic', phoneNumbers: ['+13035550100'] });
  records = new PatientRecords(t.db, cipher);
  desk = new FrontDeskRepository(t.db, cipher);
  const directory = new PostgresPatientDirectory(t.db, cipher);
  pet.biscuit = await directory.create(C, { firstName: 'Biscuit', lastName: 'Quill', dob: '2020-02-14', phone: '+17205550131', guardianName: 'Nora Quill', species: 'dog' });
  pet.bishop = await directory.create(C, { firstName: 'Bishop', lastName: 'Varga', dob: '2018-06-01', phone: '+17205550132', guardianName: 'Daniel Varga', species: 'cat' });
  pet.ma = await directory.create(C, { firstName: 'Ma', lastName: 'Ortiz', dob: '2022-09-30', phone: '+17205550133', guardianName: 'Lena Ortiz', species: 'bird' });
});
afterAll(() => t.close());

describe('the keys a record is stored with', () => {
  it('keys the first one to three letters of a word apart from the whole word, so a prefix never equals a word', async () => {
    const keys = await keysOf(pet.ma);
    // "ma" is both a whole name and its own first two letters: two different keys, both stored
    expect(searchHash(cipher, ownerWordKey(C, 'ma'))).not.toBe(searchHash(cipher, namePrefixKey(C, 'ma')));
    expect(keys).toEqual(expect.arrayContaining([searchHash(cipher, ownerWordKey(C, 'ma')), searchHash(cipher, namePrefixKey(C, 'ma')), searchHash(cipher, namePrefixKey(C, 'm'))]));
    // Bishop starts with "bis" but is no whole word "bis"
    const bishop = await keysOf(pet.bishop);
    expect(bishop).toContain(searchHash(cipher, namePrefixKey(C, 'bis')));
    expect(bishop).not.toContain(searchHash(cipher, ownerWordKey(C, 'bis')));
    // nothing readable is stored
    expect(JSON.stringify(keys)).not.toMatch(/ortiz|lena|0133/i);
  });
});

describe('a search from one letter, by keys alone', () => {
  it('finds a record by the first letter of its own name and of its owner\'s', async () => {
    expect(await names('b')).toEqual([['Biscuit', 'name'], ['Bishop', 'name']]); // by last name: Quill, Varga
    expect(await names('n')).toEqual([['Biscuit', 'owner']]); // Nora
    expect(await names('l')).toEqual([['Ma', 'owner']]); // Lena
    expect(await names('q')).toEqual([['Biscuit', 'name']]); // Quill is the pet's own last name too
    expect(await names('x')).toEqual([]);
  });

  it('lets a longer word find its candidates by three letters and decides it on the decrypted name', async () => {
    // both start "bis"; only one starts "biscu"
    expect(await names('biscu')).toEqual([['Biscuit', 'name']]);
    expect(await names('bish')).toEqual([['Bishop', 'name']]);
    expect(await names('bisque')).toEqual([]);
  });

  it('keeps "sounds like" through a key of the sound', async () => {
    expect(await names('danial')).toEqual([['Bishop', 'owner']]); // Daniel, one letter off
    expect(await names('ronald')).toEqual([]);
  });

  it('finds a phone by any run of its digits, and a birthday, without reading any other record', async () => {
    for (const q of ['0131', '555-0131', '5550131', '7205550131']) expect((await names(q)).map(([n]) => n), q).toEqual(['Biscuit']);
    expect((await names('555013')).map(([n]) => n).sort()).toEqual(['Biscuit', 'Bishop', 'Ma']); // inside every number
    expect(await names('2020-02-14')).toEqual([['Biscuit', 'dob']]);
  });

  it('keys a record with no phone too, which no rehash of its own row may change', async () => {
    const old = sealPatient(cipher, C, { firstName: 'Pumpkin', lastName: 'Hale', dob: '2016-03-03', phone: '+17205550134', guardianName: 'Ivy Hale' });
    // a record from before v0.5 made the phone required: no phone, and no keys yet
    await t.owner.execute(sql`alter table patients drop constraint patients_phone_required`);
    await t.owner.execute(sql`insert into patients (clinic_id, lookup_hash, first_name_enc, last_name_enc, dob_enc, guardian_name_enc)
      values (${C}, ${old.lookupHash}, ${old.firstNameEnc}, ${old.lastNameEnc}, ${old.dobEnc}, ${old.guardianNameEnc})`);
    await t.owner.execute(sql`alter table patients add constraint patients_phone_required check (phone_enc is not null and phone_hash is not null) not valid`);
    expect(await names('pum')).toEqual([]);
    expect(await rehashPatientLookups(t.db, cipher, { apply: true })).toMatchObject({ withoutPhone: 1, searchable: 1 });
    expect(await names('pum')).toEqual([['Pumpkin', 'name']]);
    expect(await names('iv')).toEqual([['Pumpkin', 'owner']]);
  });
});

describe('the rehash', () => {
  it('fills the keys of a record from before them: a dry run counts and writes nothing, --apply writes, a second run changes nothing', async () => {
    const id = pet.biscuit;
    const before = await keysOf(id);
    // the record as it was before migration 0049: no keys
    await t.owner.execute(sql`delete from patient_search_keys where patient_id = ${id}`);
    const dry = await rehashPatientLookups(t.db, cipher, { apply: false });
    expect(dry).toMatchObject({ changed: 1, searchable: 1 });
    expect(await keysOf(id)).toEqual([]);
    expect(await names('n')).toEqual([]); // not found by a key until the keys are written
    const applied = await rehashPatientLookups(t.db, cipher, { apply: true });
    expect(applied).toMatchObject({ changed: 1, searchable: 1 });
    expect(await keysOf(id)).toEqual(before);
    expect(await names('n')).toEqual([['Biscuit', 'owner']]);
    expect(await rehashPatientLookups(t.db, cipher, { apply: true })).toMatchObject({ changed: 0, searchable: 0 });
  });

  it('fills a call\'s digit keys the same way', async () => {
    const calls = new CallRepository(t.db, cipher);
    const id = await calls.open(C, 'keys_rehash_1', '+17205550135');
    const before = (await callKeysOf(id)).sort();
    await t.owner.execute(sql`delete from call_search_keys where call_id = ${id}`);
    expect(await desk.callIdsByNumber(C, '50135')).toEqual([]);
    expect(await rehashCallLookups(t.db, cipher, { apply: false })).toMatchObject({ changed: 1 });
    expect(await callKeysOf(id)).toEqual([]);
    expect(await rehashCallLookups(t.db, cipher, { apply: true })).toMatchObject({ changed: 1 });
    expect((await callKeysOf(id)).sort()).toEqual(before);
    expect(await rehashCallLookups(t.db, cipher, { apply: true })).toMatchObject({ changed: 0 });
    expect(await desk.callIdsByNumber(C, '50135')).toEqual([id]);
  });
});

describe('the Calls search by digits', () => {
  it('finds a call by any run of the digits of its number through the keys, and no longer once the number is purged', async () => {
    const calls = new CallRepository(t.db, cipher);
    const a = await calls.open(C, 'keys_call_a', '+17205550136');
    const b = await calls.open(C, 'keys_call_b', '+13035550137');
    expect(await desk.callIdsByNumber(C, '0136')).toEqual([a]);
    expect(await desk.callIdsByNumber(C, '303')).toEqual([b]);
    expect(await desk.callIdsByNumber(C, '5550137')).toEqual([b]);
    expect(await desk.callIdsByNumber(C, '30')).toEqual([b]); // two digits: the start of a number only
    // ATTENDRA_SEARCH_SCAN reads the numbers of the newest calls again, keys or not
    await t.owner.execute(sql`delete from call_search_keys where call_id = ${b}`);
    expect(await desk.callIdsByNumber(C, '0137')).toEqual([]);
    expect(await new FrontDeskRepository(t.db, cipher, { scan: true }).callIdsByNumber(C, '0137')).toEqual([b]);
    // the retention purge takes the number, and the keys with it
    await purgeCallRecords(t.db, C, new Date(Date.now() + 60_000));
    expect(await callKeysOf(a)).toEqual([]);
    expect(await desk.callIdsByNumber(C, '0136')).toEqual([]);
  });
});

describe('the Requests search', () => {
  it('finds a request past the newest it reads, by its patient\'s or owner\'s name, a phone\'s digits or its number', async () => {
    const queue = new PostgresTaskQueue(t.db, cipher);
    const old = await queue.create(C, { type: 'callback', callId: null, patientId: pet.bishop, idempotencyKey: 'keys-old', details: { reason: 'a sore paw' } });
    await t.owner.execute(sql`update tasks set created_at = now() - interval '90 days' where id = ${old.id}`);
    // newer requests than it, more than one search reads: the same sealed details on each, so they cost one encryption
    const filler = cipher.encrypt(JSON.stringify({ reason: 'filler' }), phiContext(C, 'tasks.details'));
    await t.owner.execute(sql`insert into tasks (clinic_id, type, details_enc, idempotency_key, number) select ${C}, 'callback', ${filler}, 'keys-fill-' || g, 500000 + g from generate_series(1, ${TASK_SEARCH_SCAN + 10}) g`);
    const find = async (q: string) => (await desk.listTasks(C, { status: 'open', limit: 50, q }, 'u_kim')).map((x) => x.id);
    for (const q of ['varga', 'dan', 'bish', '0132', `R-${old.number}`, 'daniel callback']) expect(await find(q), q).toEqual([old.id]);
    // words in the details have no keys: only the newest are read for them
    expect(await find('paw')).toEqual([]);
  });
});

describe('one audit row per search', () => {
  it('writes one patient.searched row per keystroke, and each patient shown once in a few minutes, not once per keystroke', async () => {
    const searched = (await audit('patient.searched')).length;
    const results = (await audit('patient.search.result')).length;
    const kim = new PatientRecords(t.db, cipher);
    for (const q of ['b', 'bi', 'bis', 'bisc', 'biscu']) await kim.search(C, q, 'u_lee');
    const rows = await audit('patient.searched');
    expect(rows.slice(searched)).toEqual(['matches:2', 'matches:2', 'matches:2', 'matches:1', 'matches:1']);
    // five searches showed Biscuit five times and Bishop three: one row each
    expect((await audit('patient.search.result')).slice(results).sort()).toEqual([pet.bishop, pet.biscuit].sort());
    // opening a record is its own view, every time
    await kim.profile(C, pet.biscuit, 'u_lee');
    await kim.profile(C, pet.biscuit, 'u_lee');
    expect((await audit('patient.viewed')).filter((id: string) => id === pet.biscuit)).toHaveLength(2);
  });

  it('writes one tasks.searched row per search of the requests, with how many matched', async () => {
    const before = (await audit('tasks.searched')).length;
    for (const q of ['v', 'va', 'var']) await desk.listTasks(C, { status: 'open', limit: 50, q }, 'u_lee');
    expect((await audit('tasks.searched')).slice(before)).toEqual(['matches:1', 'matches:1', 'matches:1']);
  });
});
