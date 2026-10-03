// SPDX-License-Identifier: AGPL-3.0-only
import { CEDAR_PARK_CLINIC, type ClinicConfig, DEMO_CLINIC } from '@attendra/core';
import { and, eq } from 'drizzle-orm';
import { type Database, withClinic } from './client';
import type { PhiCipher } from './crypto';
import { saveClinic } from './repositories/calls';
import { demoGender } from './demo-schedule';
import { identityKey, PostgresPatientDirectory } from './repositories/patients';
import { clinics, patients } from './schema';

/**
 * Synthetic demo patients. Invented names, 555-01xx numbers, no relation to any real
 * person. Two of them share a name and date of birth on purpose, and only their phone
 * numbers tell them apart; Maria's two children are on her number, as a family's are.
 */
export const DEMO_PATIENTS = [
  { key: 'maria', firstName: 'Maria', lastName: 'Delgado', dob: '1985-03-04', phone: '+13035550147' },
  { key: 'james', firstName: 'James', lastName: 'Whitaker', dob: '1962-09-09', phone: '+13035550163' },
  { key: 'sam_a', firstName: 'Sam', lastName: 'Rivera', dob: '1990-07-15', phone: '+13035550171' },
  { key: 'sam_b', firstName: 'Sam', lastName: 'Rivera', dob: '1990-07-15', phone: '+13035550172' },
  { key: 'lucas', firstName: 'Lucas', lastName: 'Delgado', dob: '2019-05-12', phone: '+13035550147', guardianName: 'Maria Delgado' },
  { key: 'sofia', firstName: 'Sofia', lastName: 'Delgado', dob: '2023-11-02', phone: '+13035550147', guardianName: 'Maria Delgado' },
] as const;

/** The Cedar Park demo clinic's two patients: invented, like the rest. */
export const CEDAR_PARK_PATIENTS = [
  { key: 'ruth', firstName: 'Ruth', lastName: 'Okafor', dob: '1971-06-02', phone: '+17205550152' },
  { key: 'leon', firstName: 'Leon', lastName: 'Marsh', dob: '1995-01-19', phone: '+17205550153' },
] as const;

/** The Maple Street demo clinic and its patients, in the demo organization. */
export const seedDemo = (db: Database, cipher: PhiCipher) => seedDemoClinic(db, cipher, DEMO_CLINIC, 'org_demo', DEMO_PATIENTS);

/** The Cedar Park demo clinic, in an organization of its own: nobody at Maple Street can see it. */
export const seedCedarPark = (db: Database, cipher: PhiCipher) => seedDemoClinic(db, cipher, CEDAR_PARK_CLINIC, 'org_cedar_park', CEDAR_PARK_PATIENTS);

export async function seedDemoClinic(db: Database, cipher: PhiCipher, clinic: ClinicConfig, orgId: string, people: readonly { key: string; firstName: string; lastName: string; dob: string; phone: string; guardianName?: string }[]) {
  // Only the first time: after that the clinic belongs to whoever edits it in the dashboard.
  const [existing] = await db.select({ id: clinics.id }).from(clinics).where(eq(clinics.id, clinic.id));
  if (!existing) await saveClinic(db, orgId, clinic);
  const directory = new PostgresPatientDirectory(db, cipher, 'seed');
  const ids: Record<string, string> = {};
  // Safe to run twice: each demo patient is found again by their name, date of birth
  // and phone instead of being created a second time.
  for (const p of people) {
    const [existing] = await withClinic(db, clinic.id, (tx) => tx.select({ id: patients.id }).from(patients)
      .where(and(eq(patients.clinicId, clinic.id), eq(patients.identityHash, cipher.hash(identityKey(clinic.id, p.firstName, p.lastName, p.dob, p.phone))))));
    ids[p.key] = existing?.id ?? await directory.create(clinic.id, { ...p, gender: demoGender(p.firstName) });
  }
  return { clinic, patientIds: ids };
}
