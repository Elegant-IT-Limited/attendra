// SPDX-License-Identifier: AGPL-3.0-only
// The bake-off clinic (batch 1a): a clinic of made-up data for comparing voice engines on a real deployment, with the
// demo clinic's vets, visit types and households (all made up, 555 numbers) under its own organization and no logins.
// It books out of hours (as the comparison runs at any hour) and texts nobody. Dry run by default; --apply writes it.
// Safe to run twice. Never a real clinic's data; removed with the test-data reset before the first real clinic.
//   pnpm db:seed-bakeoff [--apply]
import { ClinicConfig, RIVERBEND_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { RIVERBEND_PETS, seedDemoClinic } from '../src/seed';

export const BAKEOFF_CLINIC_ID = 'clinic_bakeoff';
const NAME = 'Bake-off Animal Hospital';
const NUMBER = '+17205550190';
const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const apply = process.argv.includes('--apply');
const clinic = ClinicConfig.parse({
  ...RIVERBEND_CLINIC, id: BAKEOFF_CLINIC_ID, name: NAME, phoneNumbers: [NUMBER], afterHours: 'book',
  greeting: RIVERBEND_CLINIC.greeting.replace('Riverbend Animal Hospital', NAME),
  texting: { ...RIVERBEND_CLINIC.texting, enabled: false },
});
const db = connect(process.env.DATABASE_URL);
const [taken] = (await db.execute(sql`select clinic_id from phone_numbers where e164 = ${NUMBER}`)).rows as { clinic_id: string }[];
if (taken && taken.clinic_id !== BAKEOFF_CLINIC_ID) throw new Error(`${NUMBER} already belongs to another clinic; nothing written`);
const [exists] = (await db.execute(sql`select id from clinics where id = ${BAKEOFF_CLINIC_ID}`)).rows;
console.log(`${apply ? 'applying' : 'dry run'}: ${NAME} (${BAKEOFF_CLINIC_ID}) ${exists ? 'exists' : 'is new'}; ${RIVERBEND_PETS.length} made-up pets; texting off; after hours: book`);
if (apply) {
  const { patientIds } = await seedDemoClinic(db, createPhiCipher(key), clinic, 'org_bakeoff', RIVERBEND_PETS);
  console.log(`done: ${Object.keys(patientIds).length} pets on file`);
}
process.exit(0);
