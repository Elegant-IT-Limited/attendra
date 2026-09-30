// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, type ClinicConfig, DEMO_CLINICS, fromMinutes, isOpen, localDateOf, localParts, weekdayOf, zonedInstant } from '@attendra/core';
import { type Database, DEMO_SCHEDULE_PATIENTS, MAX_UPCOMING, type PhiCipher, phoneKey, PostgresPatientDirectory, schema, withClinic } from '@attendra/db';
import { join } from 'node:path';
import { and, eq, or, sql } from 'drizzle-orm';
import { loadScenarios } from './scenario';
import { clinicOf, playScenario, type ScenarioResult } from './simulator';

/**
 * Fills a demo database with real call records: every eval scenario is played through
 * the real agent, tools and database, and written the way the voice service writes a
 * live call (encrypted transcript, tool actions, tasks, audit rows). The calls are
 * then spread over the past week so the dashboard reads like a working clinic.
 *
 * Synthetic patients only. Run it on a database that holds real patient data and it
 * refuses (see the check below).
 */
export async function recordDemoCalls(db: Database, cipher: PhiCipher, patientIds: Record<string, string>, now = new Date(), opts: { bookedBy?: string; clinic?: ClinicConfig } = {}): Promise<ScenarioResult[]> {
  const clinic = opts.clinic ?? DEMO_CLINICS.maple;
  const demoIds = Object.values(DEMO_CLINICS).map((c) => c.id);
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from calls where openai_session_id not like 'demo_%'`)).rows as [{ n: number }];
  if (n > 0) throw new Error('this database already has real calls; demo calls go only into a demo database');
  const [{ a }] = (await db.execute(sql`select count(*)::int as a from appointments where clinic_id not in (${sql.join(demoIds.map((id) => sql`${id}`), sql`, `)})`)).rows as [{ a: number }];
  if (a > 0) throw new Error('this database has appointments for other clinics; demo calls go only into a demo database');

  const results: ScenarioResult[] = [];
  const booked: (typeof schema.appointments.$inferSelect)[] = [];
  // each clinic's own scenarios
  const evals = loadScenarios().filter((s) => clinicOf(s).id === clinic.id);
  // and a working week of ordinary calls, played the same way, for the clinic's current week
  const week = loadScenarios(DEMO_CALL_DIR).filter((s) => clinicOf(s).id === clinic.id);
  if (week.length) await ensurePatients(db, cipher, clinic);
  for (const scenario of [...evals, ...week]) {
    // each scenario starts from an empty calendar, as it does in the eval
    await db.execute(sql`delete from appointments where clinic_id = ${clinic.id}`);
    const result = await playScenario(db, cipher, patientIds, scenario, { record: true, sessionId: `demo_${scenario.id}` });
    results.push(result);
    // what this call booked or cancelled goes on the demo schedule afterwards
    booked.push(...await withClinic(db, clinic.id, (tx) => tx.select().from(schema.appointments).where(and(eq(schema.appointments.clinicId, clinic.id),
      or(eq(schema.appointments.createdByCallId, result.callId), eq(schema.appointments.cancelledByCallId, result.callId))))));
  }
  await db.execute(sql`delete from appointments where clinic_id = ${clinic.id}`);
  const setupCalls = new Set(((await db.execute(sql`select id from calls where clinic_id = ${clinic.id} and openai_session_id like 'setup_%'`)).rows as { id: string }[]).map((r) => r.id));
  await db.execute(sql`delete from calls where clinic_id = ${clinic.id} and openai_session_id like 'setup_%'`);
  await keepAssistantBookings(db, clinic, booked, setupCalls, now, opts.bookedBy);

  // Where each call goes in time. The eval scenarios are mostly the hard cases (hedges,
  // wrong dates of birth, emergencies), so with a working week of ordinary calls they
  // go in the two weeks before it, and the Quality page's trend reads like a clinic
  // getting better at this. A clinic with no ordinary calls keeps them in the last six days.
  const hour = 3_600_000;
  const times = new Map<string, Date>();
  const spread = (rs: ScenarioResult[], from: number, to: number) => rs.forEach((r, i) => times.set(r.callId, new Date(from + ((i + 0.5) * (to - from)) / rs.length)));
  if (week.length) {
    const today = localDateOf(now, clinic.timezone);
    const weekStart = zonedInstant(addDays(today, -((weekdayOf(today) + 6) % 7)), '00:00', clinic.timezone).getTime();
    const end = now.getTime() - Math.min(hour, (now.getTime() - weekStart) / 10);
    spread(results.slice(0, evals.length), weekStart - 14 * 24 * hour, weekStart - hour);
    // an ordinary week's calls come in while the clinic is open, every half hour it was open so far
    const open: number[] = [];
    for (let at = weekStart; at < end; at += hour / 2) if (isOpen(clinic, new Date(at + 10 * 60_000))) open.push(at + 10 * 60_000);
    const ordinary = results.slice(evals.length);
    if (open.length >= ordinary.length) ordinary.forEach((r, i) => times.set(r.callId, new Date(open[Math.floor(((i + 0.5) * open.length) / ordinary.length)]!)));
    else spread(ordinary, weekStart + Math.min(hour, (end - weekStart) / 20), end); // a week only hours old
  } else {
    // newest first on screen: the last scenario is about an hour ago, the first about six days ago
    const step = Math.min(9.5, 140 / Math.max(1, results.length - 1));
    [...results].reverse().forEach((r, i) => times.set(r.callId, new Date(now.getTime() - hour - i * step * hour)));
  }
  for (const r of results) {
    const startedAt = times.get(r.callId)!.toISOString();
    await db.execute(sql`update calls set started_at = ${startedAt}::timestamptz, ended_at = ${startedAt}::timestamptz + make_interval(secs => coalesce(voice_seconds, 60)::double precision) where id = ${r.callId}`);
    await db.execute(sql`update call_actions set created_at = ${startedAt}::timestamptz + interval '20 seconds' where call_id = ${r.callId}`);
    await db.execute(sql`update tasks set created_at = ${startedAt}::timestamptz + interval '40 seconds' where call_id = ${r.callId}`);
    await db.execute(sql`update appointments set created_at = ${startedAt}::timestamptz + interval '50 seconds' where created_by_call_id = ${r.callId}`);
  }
  return results;
}

/** Ordinary calls for the demo's current week: played through the real agent, never run as evals. */
export const DEMO_CALL_DIR = join(import.meta.dirname, '../demo-calls');

/** The demo schedule's patients who call during the week, created now (the schedule finds them by number later). */
async function ensurePatients(db: Database, cipher: PhiCipher, clinic: ClinicConfig) {
  const directory = new PostgresPatientDirectory(db, cipher, 'seed');
  for (const p of DEMO_SCHEDULE_PATIENTS.slice(0, 8)) {
    const [existing] = await withClinic(db, clinic.id, (tx) => tx.select({ id: schema.patients.id }).from(schema.patients)
      .where(and(eq(schema.patients.clinicId, clinic.id), eq(schema.patients.phoneHash, cipher.hash(phoneKey(clinic.id, p.phone))))));
    if (!existing) await directory.create(clinic.id, p);
  }
}

/**
 * Puts the demo calls' own bookings back on the calendar, so "booked by the
 * assistant" links to the call that did it. A scenario books a fixed date; one that
 * has passed moves forward by whole weeks of the clinic's calendar, so the day and
 * local time still match what the transcript says. The appointment a reschedule or cancel scenario started from was
 * set up before its call, so it is shown as booked by staff (`bookedBy`), or left out.
 * Many scenarios book for the same few patients; like the rest of the demo, nobody
 * keeps more than two upcoming visits, so the rest are left off the calendar.
 */
/**
 * The same local day and time `weeks` weeks later. Weeks are counted on the clinic's
 * calendar, not in milliseconds, so 8:00 stays 8:00 across a daylight saving change.
 */
export function shiftByWeeks(instant: Date, weeks: number, timeZone: string): Date {
  const local = localParts(instant, timeZone);
  return zonedInstant(addDays(local.date, 7 * weeks), fromMinutes(local.minutes), timeZone);
}

async function keepAssistantBookings(db: Database, clinic: ClinicConfig, rows: (typeof schema.appointments.$inferSelect)[], setupCalls: Set<string>, now: Date, bookedBy?: string) {
  const week = 7 * 86_400_000;
  const tz = clinic.timezone;
  const used = new Set<string>(); // cancelled rows can share a slot in the database, but not on screen
  const upcoming = new Map<string, number>();
  for (const row of rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
    const fromSetup = !!row.createdByCallId && setupCalls.has(row.createdByCallId);
    if (fromSetup && !bookedBy) continue;
    if (row.status === 'booked' && (upcoming.get(row.patientId) ?? 0) >= MAX_UPCOMING) continue;
    const minutes = row.endsAt.getTime() - row.startsAt.getTime();
    let weeks = row.startsAt < now ? Math.ceil((now.getTime() - row.startsAt.getTime()) / week) : 0;
    for (let attempt = 0; attempt < 4; attempt++, weeks++) {
      const startsAt = shiftByWeeks(row.startsAt, weeks, tz);
      if (startsAt < now) continue; // a clock change can leave the first try an hour short
      const slot = `${row.providerId}@${startsAt.toISOString()}`;
      if (used.has(slot) || clinic.holidays.includes(localDateOf(startsAt, tz))) continue;
      try {
        await withClinic(db, clinic.id, (tx) => tx.insert(schema.appointments).values({
          ...row, startsAt, endsAt: new Date(startsAt.getTime() + minutes),
          ...(fromSetup ? { createdByCallId: null, createdByUserId: bookedBy } : {}),
        }));
        used.add(slot);
        if (row.status === 'booked') upcoming.set(row.patientId, (upcoming.get(row.patientId) ?? 0) + 1);
        break;
      } catch (err) {
        const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (code !== '23P01') throw err; // two scenarios booked the same slot; try the week after
      }
    }
  }
}
