// SPDX-License-Identifier: AGPL-3.0-only
import { callUsNumber, RIVERBEND_CLINIC, type SmsTemplateName, speakSlot, textPreview } from '@attendra/core';
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
 * With 60 more for volume (texts polish TX3).
 */
async function seedDemoTexts(db: Database, cipher: PhiCipher, pets: Record<string, string>, now: Date) {
  const clinicId = RIVERBEND_CLINIC.id;
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const [visit] = await withClinic(db, clinicId, (tx) => tx.select({ id: schema.appointments.id }).from(schema.appointments)
    .where(and(eq(schema.appointments.clinicId, clinicId), eq(schema.appointments.patientId, pets.biscuit!))).orderBy(desc(schema.appointments.startsAt)).limit(1));
  const [refill] = await withClinic(db, clinicId, (tx) => tx.select({ id: schema.tasks.id, number: schema.tasks.number }).from(schema.tasks)
    .where(and(eq(schema.tasks.clinicId, clinicId), eq(schema.tasks.type, 'refill'))).orderBy(desc(schema.tasks.createdAt)).limit(1));
  const body = (words: string) => cipher.encrypt(words, phiContext(clinicId, 'sms_messages.body'));
  // the words as the messenger renders them (core textPreview: the same parts the worker and the assistant send)
  const words = (template: SmsTemplateName, vars: Record<string, string>) => body(textPreview(template, { clinic: RIVERBEND_CLINIC.name, clinicPhone: callUsNumber(RIVERBEND_CLINIC), ...vars }));
  const when = (hours: number) => speakSlot(new Date(now.getTime() + hours * 3_600_000), RIVERBEND_CLINIC.timezone, 'en');
  type Row = { template: SmsTemplateName; to: string; status: string; hours: number; patientId?: string; appointmentId?: string | null; taskId?: string | null; errorCode?: string; failureReason?: string; bodyEnc?: string };
  const rows: Row[] = [
    { template: 'booking_confirmed', to: '+17205550172', status: 'delivered', hours: 50, patientId: pets.biscuit, appointmentId: visit?.id ?? null, bodyEnc: words('booking_confirmed', { name: 'Linh', pet: 'Biscuit', visit: 'wellness exam', when: when(48) }) },
    { template: 'request_ready', to: '+17205550172', status: 'delivered', hours: 26, patientId: pets.biscuit, taskId: refill?.id ?? null, bodyEnc: words('request_ready', { pet: 'Biscuit', ...(refill ? { ref: `R-${refill.number}` } : {}) }) },
    // refused by the carrier, and about no request: the dashboard's "a text was not sent" notice is for requests' texts
    { template: 'hours', to: '+17205550172', status: 'failed', errorCode: '30006', failureReason: 'carrier', hours: 20, patientId: pets.biscuit, bodyEnc: words('hours', { hours: 'Mon-Fri 8 AM-6 PM, Sat 9 AM-1 PM' }) },
    { template: 'directions', to: '+17205550172', status: 'not_sent', failureReason: 'opted_out', hours: 3, patientId: pets.biscuit },
    { template: 'reminder', to: '+17205550173', status: 'delivered', hours: 2, patientId: pets.pepper, bodyEnc: words('reminder', { name: 'Daniel', pet: 'Pepper', visit: 'vaccine appointment', when: when(22) }) },
    ...volume(pets),
  ];
  /**
   * Volume for the Texts page (texts polish TX3, 2026-11-17): 60 more over the past 9 days, every kind, mostly
   * delivered, a few not sent (none about a request), and the oldest few with no words kept, as texts from before the
   * history feature have none (TX5). Made up throughout: the demo's four households and a number not on file.
   */
  function volume(p: Record<string, string>): Row[] {
    const homes = [
      { to: '+17205550172', patientId: p.mochi, name: 'Linh', pet: 'Mochi' }, { to: '+17205550172', patientId: p.biscuit, name: 'Linh', pet: 'Biscuit' },
      { to: '+17205550173', patientId: p.pepper, name: 'Daniel', pet: 'Pepper' }, { to: '+17205550174', patientId: p.luna, name: 'Carmen', pet: 'Luna' },
      { to: '+17205550188' },
    ];
    const kinds: SmsTemplateName[] = ['booking_confirmed', 'reminder', 'hours', 'directions', 'change_confirmed', 'answer', 'cancel_confirmed', 'link', 'reminder', 'booking_confirmed'];
    const out: Row[] = [];
    for (let i = 0; i < 60; i++) {
      const home = homes[i % homes.length]!;
      const template = home.patientId ? kinds[i % kinds.length]! : (['hours', 'directions', 'link', 'answer'] as const)[i % 4]!;
      const hours = 4 + i * 3.4;
      const status = i % 13 === 5 ? 'failed' : i % 17 === 8 ? 'not_sent' : i % 6 === 0 ? 'sent' : 'delivered';
      const vars: Record<string, string> = { ...(home.name ? { name: home.name, pet: home.pet! } : {}), visit: 'wellness exam', provider: 'Dr. Elena Ruiz', when: when(24 - hours), from: when(30 - hours),
        hours: 'Mon-Fri 8 AM-6 PM, Sat 9 AM-1 PM', address: RIVERBEND_CLINIC.address!, mapUrl: 'https://maps.google.com/?q=88%20Riverbend%20Road', answer: 'We take cards and cash.',
        label: 'New client form', url: 'https://riverbend.example/new-client' };
      out.push({
        template, to: home.to, status, hours, ...(home.patientId ? { patientId: home.patientId } : {}),
        ...(status === 'failed' ? { errorCode: '30003', failureReason: 'carrier' } : status === 'not_sent' ? { failureReason: 'rate_limited' } : {}),
        // the oldest ones have no words: sent before the clinic kept them
        ...(status === 'not_sent' || i >= 52 ? {} : { bodyEnc: words(template, vars) }),
      });
    }
    return out;
  }
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
