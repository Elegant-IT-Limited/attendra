import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPhiCipher, nameMatches, PatientRecords, readQuery, saveClinic, seedDemo } from '../src';
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
  it('reads a date of birth, a full phone number, or a name', () => {
    expect(readQuery('03/04/1985', today)).toEqual({ kind: 'dob', dob: '1985-03-04' });
    expect(readQuery('March 4th, 1985', today)).toEqual({ kind: 'dob', dob: '1985-03-04' });
    expect(readQuery('+1 (303) 555-0147', today)).toEqual({ kind: 'phone', digits: '3035550147' });
    expect(readQuery('  Delgado ', today)).toEqual({ kind: 'name', words: ['delgado'] });
    expect(readQuery('José', today)).toEqual({ kind: 'name', words: ['jose'] });
  });

  it('refuses what it cannot read rather than guess', () => {
    expect(readQuery('555-01', today)).toBeNull(); // part of a phone number
    expect(readQuery('3/4/85', today)).toBeNull(); // a two-digit year
    expect(readQuery('a', today)).toBeNull();
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
    expect(await records.search(OTHER.id, 'delgado', 'u_otto')).toEqual([]);
    expect(await records.search(OTHER.id, '303 555 0147', 'u_otto')).toEqual([]);
    expect((await records.search(DEMO_CLINIC.id, 'delgado', 'u_ana'))!.map((p) => p.lastName)).toEqual(['Delgado']);
  });

  it('audits every search in the clinic that ran it, with the count only', async () => {
    const rows = (await t.db.execute(sql`select clinic_id, entity_id from audit_logs where action = 'patient.searched' order by id`)).rows;
    expect(rows).toEqual([
      { clinic_id: OTHER.id, entity_id: 'matches:0' },
      { clinic_id: OTHER.id, entity_id: 'matches:0' },
      { clinic_id: DEMO_CLINIC.id, entity_id: 'matches:1' },
    ]);
  });
});
