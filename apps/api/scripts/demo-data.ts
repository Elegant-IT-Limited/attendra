// SPDX-License-Identifier: AGPL-3.0-only
import { DHANMONDI_CLINIC } from '@attendra/core';
import { type Database, DHANMONDI_SCHEDULE_PATIENTS, type PhiCipher, schema, seedDemo, seedDemoSchedule, seedDhanmondi } from '@attendra/db';
import { LocalEmbedder, seedDemoKnowledge } from '@attendra/knowledge';
import { createLogger } from '@attendra/observability';
import { handlers } from '@attendra/worker/runtime';
import { LocalSummariser } from '@attendra/worker/summarise';
import { isNotNull } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { recordDemoCalls } from '@attendra/evals/demo';
import type { Auth } from '../src/auth';
import { addMember } from '../src/members';

/** The demo logins. The Dhanmondi one belongs to a different organization and sees only its own clinic. */
export const DEMO_LOGINS = [
  { email: 'frontdesk@maple-demo.test', name: 'Jordan (front desk)', label: 'Front desk', role: 'staff' as const, orgId: 'org_demo' },
  { email: 'manager@maple-demo.test', name: 'Priya (practice manager)', label: 'Practice manager', role: 'admin' as const, orgId: 'org_demo' },
  { email: 'frontdesk@dhanmondi-demo.test', name: 'Nusrat (front desk)', label: 'Dhanmondi front desk', role: 'staff' as const, orgId: 'org_dhanmondi' },
];

const DHANMONDI_NOTES = ['Fasting sample.', 'Home collection: call on arrival.', 'Report to be emailed.', 'Wheelchair access needed.', 'Follow-up from last visit.'];
/** The local demo's password (`pnpm demo`, gone when the process stops). A deployed demo gets its own. */
export const LOCAL_DEMO_PASSWORD = 'attendra-demo-password';

/**
 * Both demo clinics, their synthetic patients, the demo logins, a week of recorded
 * calls each, and two weeks of appointments: the ones those calls booked, and the
 * rest by staff.
 */
export async function seedDemoWorkspace(db: Database, cipher: PhiCipher, auth: Auth, password: string, now = new Date()) {
  const maple = await seedDemo(db, cipher);
  const dhanmondi = await seedDhanmondi(db, cipher);
  const staff: Record<string, string[]> = {};
  for (const l of DEMO_LOGINS) (staff[l.orgId] ??= []).push(await addMember(auth, db, { email: l.email, name: l.name, role: l.role, password, orgId: l.orgId }));
  // the clinic's documents, indexed with local embeddings: the demo needs no key for them
  await seedDemoKnowledge(db, new LocalEmbedder(), staff.org_demo![1]);
  const results = await recordDemoCalls(db, cipher, maple.patientIds, now, { bookedBy: staff.org_demo![0] });
  await seedDemoSchedule(db, cipher, { patientIds: maple.patientIds, staffUserIds: staff.org_demo!, now });
  results.push(...await recordDemoCalls(db, cipher, dhanmondi.patientIds, now, { bookedBy: staff.org_dhanmondi![0], clinic: DHANMONDI_CLINIC }));
  await seedDemoSchedule(db, cipher, { patientIds: dhanmondi.patientIds, staffUserIds: staff.org_dhanmondi!, now, clinic: DHANMONDI_CLINIC, extraPatients: DHANMONDI_SCHEDULE_PATIENTS, notes: DHANMONDI_NOTES });
  await summariseDemoCalls(db, cipher);
  return results;
}

/**
 * Every recorded demo call gets its summary now, written from the call's facts by
 * the local summariser, so the demo starts the same every time and never spends
 * OpenAI credit on calls nobody made. Calls made later go through the worker.
 */
export async function summariseDemoCalls(db: Database, cipher: PhiCipher) {
  const quiet = createLogger({ name: 'demo', destination: new Writable({ write: (_c, _e, done) => done() }) });
  const h = handlers({ boss: { send: async () => null }, db, cipher, summariser: new LocalSummariser(), log: quiet });
  // owner connection, like the rest of the seed: which calls exist, ids only
  for (const c of await db.select({ id: schema.calls.id, clinicId: schema.calls.clinicId }).from(schema.calls).where(isNotNull(schema.calls.endedAt))) {
    await h.summariseCall({ clinicId: c.clinicId, callId: c.id });
  }
}
