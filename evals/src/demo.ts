// SPDX-License-Identifier: AGPL-3.0-only
import { DEMO_CLINIC } from '@attendra/core';
import { type Database, type PhiCipher } from '@attendra/db';
import { sql } from 'drizzle-orm';
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
export async function recordDemoCalls(db: Database, cipher: PhiCipher, patientIds: Record<string, string>, now = new Date()): Promise<ScenarioResult[]> {
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from calls where openai_session_id not like 'demo_%'`)).rows as [{ n: number }];
  if (n > 0) throw new Error('this database already has real calls; demo calls go only into a demo database');
  const [{ a }] = (await db.execute(sql`select count(*)::int as a from appointments where clinic_id <> ${DEMO_CLINIC.id}`)).rows as [{ a: number }];
  if (a > 0) throw new Error('this database has appointments for other clinics; demo calls go only into a demo database');

  const results: ScenarioResult[] = [];
  for (const scenario of loadScenarios()) {
    // each scenario starts from an empty calendar, as it does in the eval
    await db.execute(sql`delete from appointments where clinic_id = ${DEMO_CLINIC.id}`);
    results.push(await playScenario(db, cipher, patientIds, scenario, { record: true, sessionId: `demo_${scenario.id}` }));
  }
  await db.execute(sql`delete from calls where clinic_id = ${DEMO_CLINIC.id} and openai_session_id like 'setup_%'`);

  // Newest first on screen: the last scenario is about an hour ago, the first about six days ago.
  const hour = 3_600_000;
  for (const [i, r] of [...results].reverse().entries()) {
    const startedAt = new Date(now.getTime() - hour - i * 9.5 * hour).toISOString();
    await db.execute(sql`update calls set started_at = ${startedAt}::timestamptz, ended_at = ${startedAt}::timestamptz + make_interval(secs => coalesce(voice_seconds, 60)::double precision) where id = ${r.callId}`);
    await db.execute(sql`update call_actions set created_at = ${startedAt}::timestamptz + interval '20 seconds' where call_id = ${r.callId}`);
    await db.execute(sql`update tasks set created_at = ${startedAt}::timestamptz + interval '40 seconds' where call_id = ${r.callId}`);
  }
  return results;
}
