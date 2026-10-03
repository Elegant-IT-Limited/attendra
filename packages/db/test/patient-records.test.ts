import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPhiCipher, nameMatches, PatientRecords, phoneMatch, readQuery, saveClinic, seedDemo } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let records: PatientRecords;

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  await saveClinic(t.db, 'org_other', OTHER);
  records = new PatientRecords(t.db, cipher);
});
afterAll(() => t.close());

describe('reading a search box', () => {
  const today = new Date('2026-09-29T12:00:00Z');
  it('reads a date of birth, digits of a phone number, or the start of a name, from the first character', () => {
    expect(readQuery('03/04/1985', today)).toEqual({ kind: 'dob', dob: '1985-03-04' });
    expect(readQuery('March 4th, 1985', today)).toEqual({ kind: 'dob', dob: '1985-03-04' });
    expect(readQuery('+1 (303) 555-0147', today)).toEqual({ kind: 'phone', digits: '13035550147' });
    expect(readQuery('017', today)).toEqual({ kind: 'phone', digits: '017' });
    expect(readQuery('555-01', today)).toEqual({ kind: 'phone', digits: '55501' });
    expect(readQuery('  Delgado ', today)).toEqual({ kind: 'name', words: ['delgado'] });
    expect(readQuery('m', today)).toEqual({ kind: 'name', words: ['m'] });
    expect(readQuery('José', today)).toEqual({ kind: 'name', words: ['jose'] });
  });

  it('refuses what it cannot read rather than guess', () => {
    expect(readQuery('3/4/85', today)).toBeNull(); // a two-digit year
    expect(readQuery('   ', today)).toBeNull();
  });

  it('finds a phone number from any few digits, numbers that start with them first', () => {
    expect(phoneMatch('303', '+1 (303) 555-0147')).toBe(0);
    expect(phoneMatch('0147', '+1 (303) 555-0147')).toBe(1);
    expect(phoneMatch('079', '+44 7911 123456')).toBe(0); // dialled at home as 07911 123456
    expect(phoneMatch('999', '+1 (303) 555-0147')).toBeNull();
    expect(phoneMatch('303', null)).toBeNull();
  });

  it('matches each typed word against the start of a name word', () => {
    const maria = { firstName: 'Maria', lastName: 'Delgado' };
    expect(nameMatches(['del'], maria)).toBe(true);
    expect(nameMatches(['mar', 'del'], maria)).toBe(true);
    expect(nameMatches(['elgado'], maria)).toBe(false);
    expect(nameMatches(['del', 'x'], maria)).toBe(false);
    expect(nameMatches(['ibanez'], { firstName: 'Rosa', lastName: 'Ibáñez' })).toBe(true);
  });
});

describe('search across clinics', () => {
  it('never returns another clinic\'s patients, by name or by phone', async () => {
    expect(await records.search(OTHER.id, 'delgado', 'u_otto')).toEqual({ patients: [], truncated: false });
    expect(await records.search(OTHER.id, '303 555 0147', 'u_otto')).toEqual({ patients: [], truncated: false });
    // Maria and her two children, all on her phone
    expect((await records.search(DEMO_CLINIC.id, 'delgado', 'u_ana'))!.patients.map((p) => p.firstName)).toEqual(['Lucas', 'Maria', 'Sofia']);
  });

  it('audits every search in the clinic that ran it, with the count only', async () => {
    const rows = (await t.db.execute(sql`select clinic_id, entity_id from audit_logs where action = 'patient.searched' order by id`)).rows;
    const results = (await t.db.execute(sql`select clinic_id, actor, entity from audit_logs where action = 'patient.search.result'`)).rows;
    expect(results).toEqual(Array(3).fill({ clinic_id: DEMO_CLINIC.id, actor: 'user:u_ana', entity: 'patient' })); // one row per patient shown
    expect(rows).toEqual([
      { clinic_id: OTHER.id, entity_id: 'matches:0' },
      { clinic_id: OTHER.id, entity_id: 'matches:0' },
      { clinic_id: DEMO_CLINIC.id, entity_id: 'matches:3' },
    ]);
  });
});

describe('the scan cap', () => {
  it('reads patients in a fixed order and says when it stopped at the cap', async () => {
    const capped = new PatientRecords(t.db, cipher, 2);
    const ids = ((await t.db.execute(sql`select id from patients where clinic_id = ${DEMO_CLINIC.id} order by id limit 2`)).rows as { id: string }[]).map((r) => r.id);
    const runs = await Promise.all([capped.search(DEMO_CLINIC.id, '1985-03-04', 'u_ana'), capped.search(DEMO_CLINIC.id, '1985-03-04', 'u_ana')]);
    expect(runs.map((r) => r!.truncated)).toEqual([true, true]);
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]!.patients.every((p) => ids.includes(p.id))).toBe(true); // only the first two by id were read
    expect((await new PatientRecords(t.db, cipher).search(DEMO_CLINIC.id, '1985-03-04', 'u_ana'))!.truncated).toBe(false);
  });
});
