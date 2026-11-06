import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPhiCipher, PatientRecords, PATIENT_SCAN_LIMIT, saveClinic, schema, sealPatient, searchKeyHashes } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

/**
 * How fast a search answers from the first letter on a clinic with 20,000 patients: within 200 ms for one and two
 * letters. Seeding them takes a while (every record is sealed, with all its keys), so it runs only when asked:
 *   ATTENDRA_SEARCH_TIMING=1 pnpm --filter @attendra/db exec vitest run test/search-timing.test.ts
 * Made-up names, built from syllables, and 555-01xx numbers only.
 */
const RUN = !!process.env.ATTENDRA_SEARCH_TIMING;
const cipher = createPhiCipher(TEST_DATA_KEY);
const C = 'clinic_timing';
const PATIENTS = 20_000;
const LIMIT_MS = 200;
let t: Awaited<ReturnType<typeof openTestDatabase>>;

// a fixed sequence, so every run seeds the same clinic
let state = 20261107;
const next = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
const START = ['ba', 'ce', 'di', 'fo', 'gu', 'ha', 'ji', 'ko', 'lu', 'ma', 'ne', 'po', 'ra', 'si', 'ta', 'vo', 'wi', 'ze', 'al', 'em', 'is', 'or'];
const END = ['bel', 'dor', 'fin', 'gan', 'lix', 'mon', 'nor', 'pel', 'quin', 'ros', 'tan', 'vik', 'by', 'sa', 'lo'];
const name = () => { const n = `${pick(START)}${pick(END)}`; return n[0]!.toUpperCase() + n.slice(1); };

const timed = async (records: PatientRecords, q: string) => {
  await records.search(C, q, 'u_time'); // warm
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const at = performance.now();
    await records.search(C, q, 'u_time');
    runs.push(performance.now() - at);
  }
  return runs.sort((a, b) => a - b)[2]!; // the median
};

describe.skipIf(!RUN)('search timing on 20,000 patients', () => {
  beforeAll(async () => {
    t = await openTestDatabase();
    await saveClinic(t.db, 'org_timing', { ...DEMO_CLINIC, id: C, name: 'Timing Clinic', phoneNumbers: ['+13035550100'] });
    const at = performance.now();
    for (let b = 0; b < PATIENTS; b += 500) {
      const people = Array.from({ length: Math.min(500, PATIENTS - b) }, (_, i) => {
        const owner = `${name()} ${name()}`;
        const n = b + i;
        // 555-01xx numbers, the area code varied so the numbers differ
        const phone = `+1${String(200 + (n % 800)).padStart(3, '0')}55501${String(Math.floor(n / 800) % 100).padStart(2, '0')}`;
        return { firstName: name(), lastName: owner.split(' ')[1]!, dob: `20${String(10 + (n % 15)).padStart(2, '0')}-0${1 + (n % 9)}-1${n % 10}`, phone, guardianName: owner };
      });
      const ids = await t.db.insert(schema.patients).values(people.map((p) => ({ clinicId: C, ...sealPatient(cipher, C, p) }))).returning({ id: schema.patients.id });
      const keys = people.flatMap((p, i) => searchKeyHashes(cipher, C, p).map((key) => ({ clinicId: C, key, patientId: ids[i]!.id })));
      for (let k = 0; k < keys.length; k += 15_000) await t.db.insert(schema.patientSearchKeys).values(keys.slice(k, k + 15_000));
    }
    // what autovacuum does on a real server after a load like this: the planner needs the table's statistics to choose the keys' index
    await t.db.execute(sql`analyze patients`);
    await t.db.execute(sql`analyze patient_search_keys`);
    console.warn(`seeded ${PATIENTS} patients in ${Math.round(performance.now() - at)} ms`);
  }, 600_000);
  afterAll(() => t?.close());

  it(`answers one and two letters within ${LIMIT_MS} ms, by keys alone`, async () => {
    const records = new PatientRecords(t.db, cipher);
    const found = (await records.search(C, 'm', 'u_time'))!;
    expect(found.patients.length).toBe(25);
    const ms = { m: await timed(records, 'm'), ma: await timed(records, 'ma'), b: await timed(records, 'b'), ba: await timed(records, 'ba'), '0112': await timed(records, '0112') };
    // the old scan of every record, for comparison: what ATTENDRA_SEARCH_SCAN turns back on
    const scan = await timed(new PatientRecords(t.db, cipher, { scanWindow: PATIENT_SCAN_LIMIT }), 'ma');
    console.warn(`median of 5 (ms): ${Object.entries(ms).map(([q, v]) => `"${q}" ${v.toFixed(1)}`).join(', ')}; the old scan, "ma": ${scan.toFixed(1)}`);
    for (const [q, v] of Object.entries(ms)) expect(v, q).toBeLessThan(LIMIT_MS);
  }, 600_000);
});
