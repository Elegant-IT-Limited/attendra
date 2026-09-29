// SPDX-License-Identifier: AGPL-3.0-only
import { type Database, type PhiCipher, seedDemo } from '@attendra/db';
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

/** The demo clinic, its synthetic patients, a week of recorded calls, and the demo logins. */
export async function seedDemoWorkspace(db: Database, cipher: PhiCipher, auth: Auth, password: string) {
  const { patientIds } = await seedDemo(db, cipher);
  const results = await recordDemoCalls(db, cipher, patientIds);
  for (const l of DEMO_LOGINS) await addMember(auth, db, { email: l.email, name: l.name, role: l.role, password, orgId: 'org_demo' });
  return results;
}
