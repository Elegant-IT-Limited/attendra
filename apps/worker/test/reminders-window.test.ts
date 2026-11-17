// SPDX-License-Identifier: AGPL-3.0-only
import { DEMO_CLINIC, reminderState, reminderStateLine, Texting, zonedInstant } from '@attendra/core';
import { createPhiCipher, PostgresPatientDirectory, saveClinic, schema, withClinic } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { and, eq } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/runtime';
import { LocalSummariser } from '../src/summarise';

// Texts polish TX0 (2026-11-17): reminders never went out. The job ran every 10 minutes but sent only for visits more
// than 2 hours and at most max(hours before, 3) hours away; at a setting of 2 that is a 2-to-3-hour window, which
// had closed for a visit booked (or reminders turned on) less than 2 hours before its window's end, and nothing said
// why. These replay the prod timeline on a made-up clinic, and the reasons a visit now shows when none can go.
const cipher = createPhiCipher(TEST_DATA_KEY);
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const tz = 'America/New_York';
const DAY = '2026-11-16';
const CLINIC = { ...DEMO_CLINIC, id: 'clinic_tx0', name: 'Harbor Vets', industry: 'vet' as const, timezone: tz, phoneNumbers: ['+15165550100'] };
const withReminders = (on: boolean, hoursBefore = 2, quiet: { quietFrom?: string; quietTo?: string } = {}) => {
  const config = { ...CLINIC, texting: Texting.parse({ reminders: { enabled: on, hoursBefore, ...quiet } }) };
  return saveClinic(t.db, 'org_tx0', config);
};
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let n = 0;

const at = (time: string, day = DAY) => zonedInstant(day, time, tz);
/** The runs pg-boss makes: on the clock, every 10 minutes. */
const runsBetween = (from: string, to: string, day = DAY) => {
  const out: Date[] = [];
  for (let m = at(from, day).getTime(); m <= at(to, day).getTime(); m += 10 * 60_000) out.push(new Date(m));
  return out;
};

async function owner(name: string, consent: 'import' | 'call' | 'staff' | null) {
  const id = await new PostgresPatientDirectory(t.db, cipher, 'seed').create(CLINIC.id, { firstName: name, lastName: 'Carter', dob: '2020-03-01', phone: '+15165550101', guardianName: 'Dana Carter' });
  if (consent) await withClinic(t.db, CLINIC.id, (tx) => tx.update(schema.patients).set({ smsConsentAt: at('09:00'), smsConsentSource: consent }).where(eq(schema.patients.id, id)));
  return id;
}
/** A visit booked at the desk (a staff member, no call) at `bookedAt`. */
const deskBooking = async (patientId: string, startsAt: Date, bookedAt: Date) => (await withClinic(t.db, CLINIC.id, (tx) => tx.insert(schema.appointments).values({
  clinicId: CLINIC.id, patientId, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt, endsAt: new Date(startsAt.getTime() + 20 * 60_000),
  idempotencyKey: `tx0-${++n}`, createdByUserId: 'u_desk', createdAt: bookedAt, updatedAt: bookedAt,
}).returning({ id: schema.appointments.id })))[0]!.id;
const visit = async (id: string) => (await withClinic(t.db, CLINIC.id, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.id, id))))[0]!;
const reminderRows = (id: string) => withClinic(t.db, CLINIC.id, (tx) => tx.select().from(schema.smsMessages).where(and(eq(schema.smsMessages.appointmentId, id), eq(schema.smsMessages.template, 'reminder'))));

function worker(clock: { now: Date }, bodies: string[]) {
  const texts = { send: async (m: { body: string }) => { bodies.push(m.body); return { sid: `SM${String(bodies.length).padStart(32, '0')}` }; } };
  return handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, texts, now: () => clock.now });
}

beforeAll(async () => {
  t = await openTestDatabase();
  await withReminders(false);
});
afterAll(() => t.close());

describe('appointment reminders: the prod timeline (TX0)', () => {
  it('reminders on at 2:21 PM with 2 hours before, a desk booking at 2:25 PM for 4:30 PM, owner said yes in an import: one reminder at the 2:30 PM run', async () => {
    const clock = { now: at('14:00') };
    const bodies: string[] = [];
    const h = worker(clock, bodies);
    const bella = await owner('Bella', 'import');
    for (const run of runsBetween('14:00', '14:20')) { clock.now = run; expect(await h.appointmentReminders()).toMatchObject({ sent: 0 }); }
    await withReminders(true, 2); // 2:21 PM
    const id = await deskBooking(bella, at('16:30'), at('14:25'));
    const sentAt: string[] = [];
    for (const run of runsBetween('14:30', '16:20')) {
      clock.now = run;
      const r = await h.appointmentReminders();
      if (r.sent) sentAt.push(run.toISOString());
    }
    // sent once, at the first run after the booking: inside the 2 hours (2 h 5 min away, so at once) and over an hour away
    expect(sentAt).toEqual([at('14:30').toISOString()]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^Harbor Vets: .*Bella's sick visit with Dr\. Nkem Okafor on Monday, November 16, at 4:30 PM/);
    expect(await reminderRows(id)).toEqual([expect.objectContaining({ status: 'sent', kind: 'reminder' })]);
    expect((await visit(id)).reminderSkip).toBeNull();
  });

  it('a visit booked well ahead goes out when its hours before begin, not only in a one-hour slice of them', async () => {
    await withReminders(true, 2);
    const clock = { now: at('08:00', '2026-11-18') };
    const bodies: string[] = [];
    const h = worker(clock, bodies);
    const id = await deskBooking(await owner('Milo', 'call'), at('12:00', '2026-11-18'), at('09:00'));
    const sentAt: string[] = [];
    for (const run of runsBetween('08:00', '11:50', '2026-11-18')) { clock.now = run; if ((await h.appointmentReminders()).sent) sentAt.push(run.toISOString()); }
    expect(sentAt).toEqual([at('10:00', '2026-11-18').toISOString()]);
    expect((await reminderRows(id))).toHaveLength(1);
  });
});

describe('appointment reminders: a reason on the visit when none can go (TX0)', () => {
  const panel = async (id: string, now: Date, p: { consent: boolean; phone: boolean }, hoursBefore = 2, quietNow = false) => {
    const a = await visit(id);
    const r = reminderState({ now, booked: a.status === 'booked', startsAt: a.startsAt, bookedAt: a.createdAt, reminderSentAt: a.reminderSentAt, kept: a.reminderSkip, smsStatus: null, reminders: { enabled: true, hoursBefore }, quietNow, ...p });
    return r && reminderStateLine(r, { startsAt: a.startsAt, bookedAt: a.createdAt }, (d) => d.toISOString());
  };

  it('booked 40 minutes before the visit: no reminder, and the visit says so', async () => {
    await withReminders(true, 2);
    const clock = { now: at('15:00', '2026-11-19') };
    const bodies: string[] = [];
    const h = worker(clock, bodies);
    const id = await deskBooking(await owner('Pepper', 'import'), at('15:40', '2026-11-19'), at('15:00', '2026-11-19'));
    expect(await h.appointmentReminders()).toEqual({ sent: 0 });
    expect(bodies).toEqual([]);
    const a = await visit(id);
    expect(a).toMatchObject({ reminderSkip: 'booked_late', reminderSentAt: null });
    expect(await panel(id, clock.now, { consent: true, phone: true })).toBe('No reminder: booked 40 minutes before the visit.');
    // the next runs change nothing and audit it once
    clock.now = at('15:10', '2026-11-19');
    expect(await h.appointmentReminders()).toEqual({ sent: 0 });
    const audits = await withClinic(t.db, CLINIC.id, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, id), eq(schema.auditLogs.action, 'appointment.reminder.skipped.booked_late'))));
    expect(audits).toHaveLength(1);
  });

  it('no texts consent: held while it may still come, then "No reminder: no texts consent"; a yes in time sends it', async () => {
    await withReminders(true, 2);
    const clock = { now: at('09:00', '2026-11-20') };
    const bodies: string[] = [];
    const h = worker(clock, bodies);
    const nala = await owner('Nala', null);
    const id = await deskBooking(nala, at('12:00', '2026-11-20'), at('08:00', '2026-11-20'));
    clock.now = at('10:10', '2026-11-20');
    expect(await h.appointmentReminders()).toEqual({ sent: 0 });
    expect((await visit(id)).reminderSkip).toBe('no_consent');
    expect(await panel(id, clock.now, { consent: false, phone: true })).toMatch(/^No reminder yet: no texts consent/);
    expect(await panel(id, at('11:30', '2026-11-20'), { consent: false, phone: true })).toBe('No reminder: no texts consent.');
    // the owner says yes at the desk at 10:15: the next run sends it, and the reason is gone
    await withClinic(t.db, CLINIC.id, (tx) => tx.update(schema.patients).set({ smsConsentAt: at('10:15', '2026-11-20'), smsConsentSource: 'staff' }).where(eq(schema.patients.id, nala)));
    clock.now = at('10:20', '2026-11-20');
    expect(await h.appointmentReminders()).toMatchObject({ sent: 1 });
    expect(await visit(id)).toMatchObject({ reminderSkip: null, reminderSentAt: expect.any(Date) });
  });

  it('quiet hours hold it until they end, and a visit too close by then says quiet hours', async () => {
    await withReminders(true, 24, { quietFrom: '20:00', quietTo: '08:00' });
    const clock = { now: at('21:00', '2026-11-21') };
    const bodies: string[] = [];
    const h = worker(clock, bodies);
    const early = await deskBooking(await owner('Rocky', 'import'), at('08:30', '2026-11-22'), at('10:00', '2026-11-20'));
    const later = await deskBooking(await owner('Luna', 'import'), at('11:00', '2026-11-22'), at('10:00', '2026-11-20'));
    expect(await h.appointmentReminders()).toEqual({ sent: 0 });
    expect((await visit(later)).reminderSkip).toBe('quiet_hours');
    expect(await panel(later, clock.now, { consent: true, phone: true }, 24, true)).toMatch(/^Reminder waits: quiet hours/);
    clock.now = at('08:00', '2026-11-22');
    expect(await h.appointmentReminders()).toMatchObject({ sent: 1 }); // 11:00 visit: 3 hours away
    expect(await reminderRows(later)).toHaveLength(1);
    expect(await reminderRows(early)).toHaveLength(0); // 08:30: half an hour away when quiet hours ended
    expect(await panel(early, clock.now, { consent: true, phone: true }, 24)).toBe('No reminder: quiet hours until less than an hour before the visit.');
  });

  it('reminders off: the visit says so, and nothing is sent or kept', async () => {
    await withReminders(false, 2);
    const clock = { now: at('09:00', '2026-11-23') };
    const h = worker(clock, []);
    const id = await deskBooking(await owner('Scout', 'import'), at('10:30', '2026-11-23'), at('08:00', '2026-11-23'));
    expect(await h.appointmentReminders()).toEqual({ sent: 0 });
    const a = await visit(id);
    expect(a.reminderSkip).toBeNull();
    const off = reminderState({ now: clock.now, booked: true, startsAt: a.startsAt, bookedAt: a.createdAt, reminderSentAt: null, kept: null, smsStatus: null, reminders: { enabled: false, hoursBefore: 2 }, quietNow: false, consent: true, phone: true });
    expect(off && reminderStateLine(off, { startsAt: a.startsAt, bookedAt: a.createdAt }, String)).toBe('No reminder: reminders are off in Settings > Texting.');
  });

  it('a reminder refused before the carrier (no texting set up) shows as not sent, never as texted', async () => {
    await withReminders(true, 2);
    const clock = { now: at('09:00', '2026-11-24') };
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, now: () => clock.now });
    const id = await deskBooking(await owner('Ziggy', 'import'), at('10:30', '2026-11-24'), at('08:00', '2026-11-24'));
    expect(await h.appointmentReminders()).toMatchObject({ sent: 0 });
    expect(await reminderRows(id)).toEqual([expect.objectContaining({ status: 'not_sent', failureReason: 'texting_off' })]);
    const a = await visit(id);
    expect(reminderState({ now: clock.now, booked: true, startsAt: a.startsAt, bookedAt: a.createdAt, reminderSentAt: a.reminderSentAt, kept: null, smsStatus: 'not_sent', reminders: { enabled: true, hoursBefore: 2 }, quietNow: false, consent: true, phone: true })).toEqual({ state: 'not_sent' });
  });
});
