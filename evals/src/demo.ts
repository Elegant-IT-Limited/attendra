// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, DEMO_CLINIC, fromMinutes, localDateOf, localParts, zonedInstant } from '@attendra/core';
import { type Database, type PhiCipher, schema, withClinic } from '@attendra/db';
import { and, eq, or, sql } from 'drizzle-orm';
import { loadScenarios } from './scenario';
import { playScenario, type ScenarioResult } from './simulator';

/**
 * Fills a demo database with real call records: every eval scenario is played through
 * the real agent, tools and database, and written the way the voice service writes a
 * live call (encrypted transcript, tool actions, tasks, audit rows). The calls are
 * then spread over the past week so the dashboard reads like a working clinic.
 *
 * Synthetic patients only. Run it on a database that holds real patient data and it
 * refuses (see the check below).
 */
export async function recordDemoCalls(db: Database, cipher: PhiCipher, patientIds: Record<string, string>, now = new Date(), opts: { bookedBy?: string } = {}): Promise<ScenarioResult[]> {
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from calls where openai_session_id not like 'demo_%'`)).rows as [{ n: number }];
  if (n > 0) throw new Error('this database already has real calls; demo calls go only into a demo database');
  const [{ a }] = (await db.execute(sql`select count(*)::int as a from appointments where clinic_id <> ${DEMO_CLINIC.id}`)).rows as [{ a: number }];
  if (a > 0) throw new Error('this database has appointments for other clinics; demo calls go only into a demo database');

  const results: ScenarioResult[] = [];
  const booked: (typeof schema.appointments.$inferSelect)[] = [];
  for (const scenario of loadScenarios()) {
    // each scenario starts from an empty calendar, as it does in the eval
    await db.execute(sql`delete from appointments where clinic_id = ${DEMO_CLINIC.id}`);
    const result = await playScenario(db, cipher, patientIds, scenario, { record: true, sessionId: `demo_${scenario.id}` });
    results.push(result);
    // what this call booked or cancelled goes on the demo schedule afterwards
    booked.push(...await withClinic(db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.appointments).where(and(eq(schema.appointments.clinicId, DEMO_CLINIC.id),
      or(eq(schema.appointments.createdByCallId, result.callId), eq(schema.appointments.cancelledByCallId, result.callId))))));
  }
  await db.execute(sql`delete from appointments where clinic_id = ${DEMO_CLINIC.id}`);
  const setupCalls = new Set(((await db.execute(sql`select id from calls where clinic_id = ${DEMO_CLINIC.id} and openai_session_id like 'setup_%'`)).rows as { id: string }[]).map((r) => r.id));
  await db.execute(sql`delete from calls where clinic_id = ${DEMO_CLINIC.id} and openai_session_id like 'setup_%'`);
  await keepAssistantBookings(db, booked, setupCalls, now, opts.bookedBy);

  // Newest first on screen: the last scenario is about an hour ago, the first about six days ago.
  const hour = 3_600_000;
  for (const [i, r] of [...results].reverse().entries()) {
    const startedAt = new Date(now.getTime() - hour - i * 9.5 * hour).toISOString();
    await db.execute(sql`update calls set started_at = ${startedAt}::timestamptz, ended_at = ${startedAt}::timestamptz + make_interval(secs => coalesce(voice_seconds, 60)::double precision) where id = ${r.callId}`);
    await db.execute(sql`update call_actions set created_at = ${startedAt}::timestamptz + interval '20 seconds' where call_id = ${r.callId}`);
    await db.execute(sql`update tasks set created_at = ${startedAt}::timestamptz + interval '40 seconds' where call_id = ${r.callId}`);
    await db.execute(sql`update appointments set created_at = ${startedAt}::timestamptz + interval '50 seconds' where created_by_call_id = ${r.callId}`);
  }
  return results;
}

/**
 * Puts the demo calls' own bookings back on the calendar, so "booked by the
 * assistant" links to the call that did it. A scenario books a fixed date; one that
 * has passed moves forward by whole weeks of the clinic's calendar, so the day and
 * local time still match what the transcript says. The appointment a reschedule or cancel scenario started from was
 * set up before its call, so it is shown as booked by staff (`bookedBy`), or left out.
 */
/**
 * The same local day and time `weeks` weeks later. Weeks are counted on the clinic's
 * calendar, not in milliseconds, so 8:00 stays 8:00 across a daylight saving change.
 */
export function shiftByWeeks(instant: Date, weeks: number, timeZone: string): Date {
  const local = localParts(instant, timeZone);
  return zonedInstant(addDays(local.date, 7 * weeks), fromMinutes(local.minutes), timeZone);
}

async function keepAssistantBookings(db: Database, rows: (typeof schema.appointments.$inferSelect)[], setupCalls: Set<string>, now: Date, bookedBy?: string) {
  const week = 7 * 86_400_000;
  const tz = DEMO_CLINIC.timezone;
  const used = new Set<string>(); // cancelled rows can share a slot in the database, but not on screen
  for (const row of rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
    const fromSetup = !!row.createdByCallId && setupCalls.has(row.createdByCallId);
    if (fromSetup && !bookedBy) continue;
    const minutes = row.endsAt.getTime() - row.startsAt.getTime();
    let weeks = row.startsAt < now ? Math.ceil((now.getTime() - row.startsAt.getTime()) / week) : 0;
    for (let attempt = 0; attempt < 4; attempt++, weeks++) {
      const startsAt = shiftByWeeks(row.startsAt, weeks, tz);
      if (startsAt < now) continue; // a clock change can leave the first try an hour short
      const slot = `${row.providerId}@${startsAt.toISOString()}`;
      if (used.has(slot) || DEMO_CLINIC.holidays.includes(localDateOf(startsAt, tz))) continue;
      try {
        await withClinic(db, DEMO_CLINIC.id, (tx) => tx.insert(schema.appointments).values({
          ...row, startsAt, endsAt: new Date(startsAt.getTime() + minutes),
          ...(fromSetup ? { createdByCallId: null, createdByUserId: bookedBy } : {}),
        }));
        used.add(slot);
        break;
      } catch (err) {
        const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (code !== '23P01') throw err; // two scenarios booked the same slot; try the week after
      }
    }
  }
}
