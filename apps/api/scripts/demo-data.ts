// SPDX-License-Identifier: AGPL-3.0-only
import { type Database, type PhiCipher, seedDemo, seedDemoSchedule } from '@attendra/db';
import { recordDemoCalls } from '@attendra/evals/demo';
import type { Auth } from '../src/auth';
import { addMember } from '../src/members';

/** The demo logins. */
export const DEMO_LOGINS = [
  { email: 'frontdesk@maple-demo.test', name: 'Jordan (front desk)', label: 'Front desk', role: 'staff' as const },
  { email: 'manager@maple-demo.test', name: 'Priya (practice manager)', label: 'Practice manager', role: 'admin' as const },
];
/** The local demo's password (`pnpm demo`, gone when the process stops). A deployed demo gets its own. */
export const LOCAL_DEMO_PASSWORD = 'attendra-demo-password';

/**
 * The demo clinic, its synthetic patients, the demo logins, a week of recorded calls,
 * and two weeks of appointments: the ones those calls booked, and the rest by staff.
 */
export async function seedDemoWorkspace(db: Database, cipher: PhiCipher, auth: Auth, password: string, now = new Date()) {
  const { patientIds } = await seedDemo(db, cipher);
  const staff: string[] = [];
  for (const l of DEMO_LOGINS) staff.push(await addMember(auth, db, { email: l.email, name: l.name, role: l.role, password, orgId: 'org_demo' }));
  const results = await recordDemoCalls(db, cipher, patientIds, now, { bookedBy: staff[0] });
  await seedDemoSchedule(db, cipher, { patientIds, staffUserIds: staff, now });
  return results;
}
