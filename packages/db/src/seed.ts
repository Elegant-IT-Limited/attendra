// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, DEMO_CLINIC, DHANMONDI_CLINIC } from '@attendra/core';
import { and, eq } from 'drizzle-orm';
import { type Database, withClinic } from './client';
import type { PhiCipher } from './crypto';
import { saveClinic } from './repositories/calls';
import { phoneKey, PostgresPatientDirectory } from './repositories/patients';
import { clinics, patients } from './schema';

/**
 * Synthetic demo patients. Invented names, 555-01xx numbers, no relation to any real
 * person. Two of them share a name and date of birth on purpose, so the "ambiguous
 * identity" path is exercised by the tests and the simulator.
 */
export const DEMO_PATIENTS = [
  { key: 'maria', firstName: 'Maria', lastName: 'Delgado', dob: '1985-03-04', phone: '+13035550147' },
  { key: 'james', firstName: 'James', lastName: 'Whitaker', dob: '1962-09-09', phone: '+13035550163' },
  { key: 'sam_a', firstName: 'Sam', lastName: 'Rivera', dob: '1990-07-15', phone: '+13035550171' },
  { key: 'sam_b', firstName: 'Sam', lastName: 'Rivera', dob: '1990-07-15', phone: '+13035550172' },
] as const;

/**
 * The Dhaka demo clinic's patients: invented people, in the +880 10 range no
 * Bangladeshi operator issues. Names are written in English letters, as the centre's
 * register writes them.
 */
export const DHANMONDI_PATIENTS = [
  { key: 'rahima', firstName: 'Rahima', lastName: 'Khatun', dob: '1979-05-12', phone: '+8801000000111' },
  { key: 'anisur', firstName: 'Anisur', lastName: 'Rahman', dob: '1968-11-03', phone: '+8801000000112' },
  { key: 'tahmina', firstName: 'Tahmina', lastName: 'Akter', dob: '1992-02-20', phone: '+8801000000113' },
  { key: 'sabbir', firstName: 'Sabbir', lastName: 'Hossain', dob: '1988-08-15', phone: '+8801000000114' },
] as const;

/** The Maple Street demo clinic and its patients, in the demo organization. */
export const seedDemo = (db: Database, cipher: PhiCipher) => seedDemoClinic(db, cipher, DEMO_CLINIC, 'org_demo', DEMO_PATIENTS);

/** The Dhanmondi demo clinic, in an organization of its own: nobody at Maple Street can see it. */
export const seedDhanmondi = (db: Database, cipher: PhiCipher) => seedDemoClinic(db, cipher, DHANMONDI_CLINIC, 'org_dhanmondi', DHANMONDI_PATIENTS);

export async function seedDemoClinic(db: Database, cipher: PhiCipher, clinic: ClinicConfig, orgId: string, people: readonly { key: string; firstName: string; lastName: string; dob: string; phone: string }[]) {
  // Only the first time: after that the clinic belongs to whoever edits it in the dashboard.
  const [existing] = await db.select({ id: clinics.id }).from(clinics).where(eq(clinics.id, clinic.id));
  if (!existing) await saveClinic(db, orgId, clinic);
  const directory = new PostgresPatientDirectory(db, cipher, 'seed');
  const ids: Record<string, string> = {};
  // Safe to run twice: each demo patient is found again by their (unique, synthetic)
  // phone number instead of being created a second time.
  for (const p of people) {
    const [existing] = await withClinic(db, clinic.id, (tx) => tx.select({ id: patients.id }).from(patients)
      .where(and(eq(patients.clinicId, clinic.id), eq(patients.phoneHash, cipher.hash(phoneKey(clinic.id, p.phone))))));
    ids[p.key] = existing?.id ?? await directory.create(clinic.id, p);
  }
  return { clinic, patientIds: ids };
}
