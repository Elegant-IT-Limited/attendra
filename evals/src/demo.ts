// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, type ClinicConfig, DEMO_CLINICS, isOpen, localDateOf, weekdayOf, zonedInstant } from '@attendra/core';
import { type Database, DEMO_SCHEDULE_PATIENTS, type PhiCipher, phoneKey, PostgresPatientDirectory, schema, withClinic } from '@attendra/db';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { loadScenarios } from './scenario';
import { clinicOf, playScenario, type ScenarioResult } from './simulator';

/**
 * Fills a demo database with real call records: every eval scenario is played through
 * the real agent, tools and database, and written the way the voice service writes a
 * live call (encrypted transcript, tool actions, tasks, audit rows). Each call runs at
 * the time it is dated, over the past weeks, so the dashboard reads like a working clinic.
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

  // each clinic's own scenarios
  const evals = loadScenarios().filter((s) => clinicOf(s).id === clinic.id);
  // and a working week of ordinary calls, played the same way, for the clinic's current week
  const week = loadScenarios(DEMO_CALL_DIR).filter((s) => clinicOf(s).id === clinic.id);
  if (week.length) await ensurePatients(db, cipher, clinic);
  const times = callTimes(clinic, now, evals.length, week.length);
  const scenarios = [...evals, ...week].map((scenario, i) => ({ scenario, at: times[i]! }));

  // Every call runs at the time it is dated, in order, on one calendar: what the assistant
  // offers and reads back is what that caller would have heard then, and a booking stays
  // where the call put it, so the transcript, the call's date and the schedule agree.
  const results: ScenarioResult[] = [];
  await db.execute(sql`delete from appointments where clinic_id = ${clinic.id}`);
  for (const { scenario, at } of [...scenarios].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const result = await playScenario(db, cipher, patientIds, scenario, { record: true, sessionId: `demo_${scenario.id}`, now: at });
    results.push(result);
    const startedAt = at.toISOString();
    await db.execute(sql`update calls set started_at = ${startedAt}::timestamptz, ended_at = ${startedAt}::timestamptz + make_interval(secs => coalesce(voice_seconds, 60)::double precision) where id = ${result.callId}`);
    await db.execute(sql`update call_actions set created_at = ${startedAt}::timestamptz + interval '20 seconds' where call_id = ${result.callId}`);
    await db.execute(sql`update tasks set created_at = ${startedAt}::timestamptz + interval '40 seconds' where call_id = ${result.callId}`);
    await db.execute(sql`update appointments set created_at = ${startedAt}::timestamptz + interval '50 seconds', updated_at = ${startedAt}::timestamptz + interval '50 seconds' where created_by_call_id = ${result.callId}`);
  }

  // the appointment a reschedule or cancel scenario started from was set up before its
  // call: it is shown as booked by staff (`bookedBy`), or left out, and the setup calls go
  const setup = sql`(select id from calls where clinic_id = ${clinic.id} and openai_session_id like 'setup_%')`;
  if (opts.bookedBy) await db.execute(sql`update appointments set created_by_call_id = null, created_by_user_id = ${opts.bookedBy} where clinic_id = ${clinic.id} and created_by_call_id in ${setup}`);
  else await db.execute(sql`delete from appointments where clinic_id = ${clinic.id} and created_by_call_id in ${setup}`);
  await db.execute(sql`delete from calls where clinic_id = ${clinic.id} and openai_session_id like 'setup_%'`);
  // back in the order the scenarios are listed, as the eval reports them
  return scenarios.map(({ scenario }) => results.find((r) => r.id === scenario.id)!);
}

/**
 * Where each call goes in time. The eval scenarios are mostly the hard cases (hedges,
 * wrong dates of birth, emergencies), so with a working week of ordinary calls they go
 * in the two weeks before it, and the Quality page's trend reads like a clinic getting
 * better at this. The ordinary calls come in while the clinic is open, every half hour
 * it was open so far this week. A clinic with no ordinary calls keeps its scenarios in
 * the last six days, the last about an hour ago.
 */
function callTimes(clinic: ClinicConfig, now: Date, evals: number, ordinary: number): Date[] {
  const hour = 3_600_000;
  const spread = (n: number, from: number, to: number) => Array.from({ length: n }, (_, i) => new Date(from + ((i + 0.5) * (to - from)) / n));
  if (!ordinary) {
    const step = Math.min(9.5, 140 / Math.max(1, evals - 1));
    return Array.from({ length: evals }, (_, i) => new Date(now.getTime() - hour - (evals - 1 - i) * step * hour));
  }
  const today = localDateOf(now, clinic.timezone);
  const weekStart = zonedInstant(addDays(today, -((weekdayOf(today) + 6) % 7)), '00:00', clinic.timezone).getTime();
  const end = now.getTime() - Math.min(hour, (now.getTime() - weekStart) / 10);
  const before = spread(evals, weekStart - 14 * 24 * hour, weekStart - hour);
  const open: number[] = [];
  for (let at = weekStart; at < end; at += hour / 2) if (isOpen(clinic, new Date(at + 10 * 60_000))) open.push(at + 10 * 60_000);
  const thisWeek = open.length >= ordinary
    ? Array.from({ length: ordinary }, (_, i) => new Date(open[Math.floor(((i + 0.5) * open.length) / ordinary)]!))
    : spread(ordinary, weekStart + Math.min(hour, (end - weekStart) / 20), end); // a week only hours old
  return [...before, ...thisWeek];
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
