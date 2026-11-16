// SPDX-License-Identifier: AGPL-3.0-only
import { RIVERBEND_CLINIC } from '@attendra/core';
import { type Database, type PhiCipher, phiContext, rehashCallLookups, rehashPatientLookups, schema, seedCedarPark, seedDemo, seedDemoSchedule, seedRiverbend, smsNumberHash, withClinic } from '@attendra/db';
import { LocalEmbedder, seedDemoKnowledge } from '@attendra/knowledge';
import { createLogger } from '@attendra/observability';
import { handlers } from '@attendra/worker/runtime';
import { LocalSummariser } from '@attendra/worker/summarise';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { recordDemoCalls } from '@attendra/evals/demo';
import type { Auth } from '../src/auth';
import { addMember } from '../src/members';

/** The demo logins. Cedar Park and Riverbend (the veterinary clinic) each have an organization of their own and see only their own clinic. */
export const DEMO_LOGINS = [
  { email: 'frontdesk@maple-demo.test', name: 'Jordan (front desk)', label: 'Front desk', role: 'staff' as const, orgId: 'org_demo' },
  { email: 'manager@maple-demo.test', name: 'Priya (practice manager)', label: 'Practice manager', role: 'admin' as const, orgId: 'org_demo', approvesRefills: true },
  { email: 'frontdesk@cedarpark-demo.test', name: 'Casey (front desk)', label: 'Cedar Park front desk', role: 'staff' as const, orgId: 'org_cedar_park' },
  { email: 'manager@riverbend-demo.test', name: 'Robin (practice manager)', label: 'Vet clinic manager', role: 'admin' as const, orgId: 'org_riverbend', approvesRefills: true },
];

/** The local demo's password (`pnpm demo`, gone when the process stops). A deployed demo gets its own. */
export const LOCAL_DEMO_PASSWORD = 'attendra-demo-password';

/**
 * The demo clinics, their synthetic patients and the demo logins. Maple Street also
 * gets recorded calls and two weeks of appointments: the ones those calls booked, and
 * the rest by staff. Cedar Park stays small: it is there to be a clinic Maple Street
 * cannot see.
 */
export async function seedDemoWorkspace(db: Database, cipher: PhiCipher, auth: Auth, password: string, now = new Date()) {
  const maple = await seedDemo(db, cipher);
  await seedCedarPark(db, cipher);
  // the veterinary clinic: its pets, its manager's login, and its call scenarios as calls from the past week
  const riverbend = await seedRiverbend(db, cipher);
  const staff: Record<string, string[]> = {};
  for (const l of DEMO_LOGINS) (staff[l.orgId] ??= []).push(await addMember(auth, db, { email: l.email, name: l.name, role: l.role, password, orgId: l.orgId, approvesRefills: 'approvesRefills' in l ? l.approvesRefills : false }));
  // the clinic's documents, indexed with local embeddings: the demo needs no key for them
  await seedDemoKnowledge(db, new LocalEmbedder(), staff.org_demo![1]);
  const results = await recordDemoCalls(db, cipher, maple.patientIds, now, { bookedBy: staff.org_demo![0] });
  results.push(...await recordDemoCalls(db, cipher, riverbend.patientIds, now, { clinic: RIVERBEND_CLINIC }));
  await seedDemoSchedule(db, cipher, { patientIds: maple.patientIds, staffUserIds: staff.org_demo!, now });
  // each demo clinic signed up before its first recorded call: Quality starts at the sign-up week, and shows the weeks those calls are in
  await db.execute(sql`update clinics set created_at = least(created_at, coalesce((select min(c.started_at) from calls c where c.clinic_id = clinics.id), created_at))`);
  // the same one-off an upgraded deployment runs (pnpm db:rehash-lookups): on a fresh demo it changes nothing
  await rehashPatientLookups(db, cipher, { apply: true });
  await rehashCallLookups(db, cipher, { apply: true });
  await summariseDemoCalls(db, cipher);
  await seedDemoTexts(db, cipher, riverbend.patientIds, now);
  return results;
}

/**
 * A few texts at the vet demo clinic, made up, so its text history has something to show (2026-11-16): a booking
 * confirmed and delivered (with the visit it confirms), a refill's ready text (with its request), opening hours the
 * carrier refused, a texted address that was not sent (the number opted out) and a reminder to another household.
 * The demo's calls play against a messenger that records nothing, so these are written here, as the real messenger
 * writes them: number hashed, words encrypted. None is a request's failed text, which would raise the dashboard's notice.
 */
async function seedDemoTexts(db: Database, cipher: PhiCipher, pets: Record<string, string>, now: Date) {
  const clinicId = RIVERBEND_CLINIC.id;
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const [visit] = await withClinic(db, clinicId, (tx) => tx.select({ id: schema.appointments.id }).from(schema.appointments)
    .where(and(eq(schema.appointments.clinicId, clinicId), eq(schema.appointments.patientId, pets.biscuit!))).orderBy(desc(schema.appointments.startsAt)).limit(1));
  const [refill] = await withClinic(db, clinicId, (tx) => tx.select({ id: schema.tasks.id }).from(schema.tasks)
    .where(and(eq(schema.tasks.clinicId, clinicId), eq(schema.tasks.type, 'refill'))).orderBy(desc(schema.tasks.createdAt)).limit(1));
  const body = (words: string) => cipher.encrypt(words, phiContext(clinicId, 'sms_messages.body'));
  const rows = [
    { template: 'booking_confirmed', to: '+17205550172', status: 'delivered', hours: 50, patientId: pets.biscuit, appointmentId: visit?.id ?? null, bodyEnc: body(`${RIVERBEND_CLINIC.name}: Biscuit's wellness exam is booked. To change or cancel, call (720) 555-0170. Reply STOP to opt out.`) },
    { template: 'request_ready', to: '+17205550172', status: 'delivered', hours: 26, patientId: pets.biscuit, taskId: refill?.id ?? null, bodyEnc: body(`${RIVERBEND_CLINIC.name}: Hi Linh, Biscuit's request is ready to pick up. Questions? Call (720) 555-0170. Reply STOP to opt out.`) },
    // refused by the carrier, and about no request: the dashboard's "a text was not sent" notice is for requests' texts
    { template: 'hours', to: '+17205550172', status: 'failed', errorCode: '30006', failureReason: 'carrier', hours: 20, patientId: pets.biscuit, bodyEnc: body(`${RIVERBEND_CLINIC.name}: We're open Monday to Friday, 8 AM to 6 PM. Reply STOP to opt out.`) },
    { template: 'directions', to: '+17205550172', status: 'not_sent', failureReason: 'opted_out', hours: 3, patientId: pets.biscuit },
    { template: 'reminder', to: '+17205550173', status: 'delivered', hours: 2, patientId: pets.pepper, bodyEnc: body(`${RIVERBEND_CLINIC.name}: A reminder: Pepper's visit is tomorrow. Reply C to confirm. Reply STOP to opt out.`) },
  ];
  await withClinic(db, clinicId, async (tx) => {
    for (const [i, r] of rows.entries()) {
      const at = ago(r.hours);
      await tx.insert(schema.smsMessages).values({
        clinicId, template: r.template, toHash: smsNumberHash(cipher, clinicId, r.to), status: r.status, idempotencyKey: `demo-text-${i}`, kind: r.template === 'reminder' ? 'reminder' : 'auto',
        patientId: r.patientId ?? null, appointmentId: r.appointmentId ?? null, taskId: r.taskId ?? null, errorCode: r.errorCode ?? null, failureReason: r.failureReason ?? null,
        bodyEnc: r.bodyEnc ?? null, createdAt: at, sentAt: r.status === 'not_sent' ? null : at, deliveredAt: r.status === 'delivered' ? at : null,
      }).onConflictDoNothing();
    }
  });
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
