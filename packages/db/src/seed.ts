// SPDX-License-Identifier: AGPL-3.0-only
import { DEMO_CLINIC } from '@attendra/core';
import type { Database } from './client';
import type { PhiCipher } from './crypto';
import { saveClinic } from './repositories/calls';
import { PostgresPatientDirectory } from './repositories/patients';

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

export async function seedDemo(db: Database, cipher: PhiCipher) {
  await saveClinic(db, 'org_demo', DEMO_CLINIC);
  const directory = new PostgresPatientDirectory(db, cipher, 'seed');
  const ids: Record<string, string> = {};
  for (const p of DEMO_PATIENTS) ids[p.key] = await directory.create(DEMO_CLINIC.id, p);
  return { clinic: DEMO_CLINIC, patientIds: ids };
}
