// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, callActions, calls, callSegments, clinics, phoneNumbers, webhookDeliveries } from '../schema';

/** What a caller's number is hashed as, per clinic: the last 10 digits, so +1 and spacing do not matter. */
export const callerKey = (clinicId: string, number: string) => `${clinicId}|${number.replace(/\D/g, '').slice(-10)}`;

/** Actor on the audit rows the call record writes: the voice service, not a person. */
const SYSTEM = 'system';

/** The call record: transcript segments, every tool action, and the close-out. Opening and closing are audited; the close records how many lines and steps the call wrote. */
export class CallRepository {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher) {}

  /** One row per OpenAI session. A second accept for the same session returns the first call. */
  /**
   * `startedBy` is the staff member behind a browser test call: the audit row is
   * written in the same transaction, so no test call exists without one.
   */
  async open(clinicId: string, openaiSessionId: string, fromNumber: string | null, channel: 'phone' | 'web' = 'phone', startedBy?: string): Promise<string> {
    return withClinic(this.db, clinicId, async (tx) => {
      const fromHash = fromNumber ? this.cipher.hash(callerKey(clinicId, fromNumber)) : null;
      const fromEnc = fromNumber ? this.cipher.encrypt(fromNumber, phiContext(clinicId, 'calls.from')) : null;
      const [row] = await tx.insert(calls).values({ clinicId, openaiSessionId, fromHash, fromEnc, channel }).onConflictDoNothing().returning({ id: calls.id });
      if (row) {
        await tx.insert(auditLogs).values(startedBy
          ? { clinicId, actor: `user:${startedBy}`, action: 'call.test.started', entity: 'call', entityId: row.id, callId: row.id }
          : { clinicId, actor: SYSTEM, action: 'call.opened', entity: 'call', entityId: row.id, callId: row.id });
        return row.id;
      }
      const [existing] = await tx.select({ id: calls.id }).from(calls).where(eq(calls.openaiSessionId, openaiSessionId));
      // RLS hides a session that belongs to another clinic; that is a routing bug, not a retry
      if (!existing) throw new Error('session id already used by another clinic');
      return existing.id;
    });
  }

  async appendSegment(clinicId: string, callId: string, s: { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }) {
    await withClinic(this.db, clinicId, async (tx) => {
      await tx.insert(callSegments).values({
        clinicId, callId, speaker: s.speaker, textEnc: this.cipher.encrypt(s.text, phiContext(clinicId, 'call_segments.text')), startMs: s.startMs, endMs: s.endMs,
      });
    });
  }

  /**
   * One tool action. `patientId` is the caller the agent has verified by name and
   * date of birth, when it has; it links the call to that patient in the same
   * transaction, so a patient's calls can be listed. A link is never replaced.
   */
  async recordAction(clinicId: string, callId: string, a: { tool: string; argsRedacted: unknown; result: unknown; taskRevision: number; patientId?: string | null }) {
    const { patientId, ...action } = a;
    await withClinic(this.db, clinicId, async (tx) => {
      await tx.insert(callActions).values({ clinicId, callId, ...action });
      if (patientId) await tx.update(calls).set({ patientId }).where(and(eq(calls.id, callId), eq(calls.clinicId, clinicId), isNull(calls.patientId)));
    });
  }

  async close(clinicId: string, callId: string, c: { reason: string; voiceSeconds: number | null; outcome: string; emergency: boolean; language?: string }) {
    await withClinic(this.db, clinicId, async (tx) => {
      await tx.update(calls).set({
        endedAt: new Date(), closeReason: c.reason, voiceSeconds: c.voiceSeconds === null ? null : c.voiceSeconds.toFixed(2),
        outcome: c.outcome, emergencyFlag: c.emergency, ...(c.language ? { language: c.language } : {}),
      }).where(and(eq(calls.id, callId), eq(calls.clinicId, clinicId)));
      // what the call wrote, as counts on one row: a row per line or step would bury staff access in the log
      const [lines] = await tx.select({ n: sql<number>`count(*)::int` }).from(callSegments).where(and(eq(callSegments.clinicId, clinicId), eq(callSegments.callId, callId)));
      const [actions] = await tx.select({ n: sql<number>`count(*)::int` }).from(callActions).where(and(eq(callActions.clinicId, clinicId), eq(callActions.callId, callId)));
      await tx.insert(auditLogs).values({ clinicId, actor: SYSTEM, action: 'call.closed', entity: 'call', entityId: callId, callId, counts: { lines: lines!.n, actions: actions!.n } });
    });
  }
}

/**
 * Runs before the tenant is known, as the connecting (owner) role: which clinic
 * owns the number that was dialled. Returns the stored config for the caller to
 * validate with ClinicConfig.parse.
 */
export async function clinicForNumber(db: Database, e164: string): Promise<unknown | null> {
  const [row] = await db.select({ config: clinics.config }).from(phoneNumbers)
    .innerJoin(clinics, eq(clinics.id, phoneNumbers.clinicId))
    .where(and(eq(phoneNumbers.e164, e164), eq(phoneNumbers.status, 'active'), isNull(clinics.closedAt)));
  return row?.config ?? null;
}

/** Every number calls come in on, with its open clinic's config: for the backup route. Owner connection; no PHI. */
export async function activeNumbers(db: Database): Promise<{ e164: string; config: unknown }[]> {
  return db.select({ e164: phoneNumbers.e164, config: clinics.config }).from(phoneNumbers)
    .innerJoin(clinics, eq(clinics.id, phoneNumbers.clinicId))
    .where(and(eq(phoneNumbers.status, 'active'), isNull(clinics.closedAt)));
}

/** A clinic's stored config by id, for a test call started from the dashboard. Owner connection; no PHI. */
export async function clinicById(db: Database, clinicId: string): Promise<unknown | null> {
  const [row] = await db.select({ config: clinics.config }).from(clinics).where(eq(clinics.id, clinicId));
  return row?.config ?? null;
}

/**
 * How much browser test-call time a clinic has: its limit (null is none) and the
 * seconds its test calls have used so far, a call still running counted up to now.
 */
export async function testCallAllowance(db: Database, clinicId: string, now: Date): Promise<{ limitSeconds: number | null; usedSeconds: number }> {
  const [row] = await db.select({ limit: clinics.testSecondsLimit }).from(clinics).where(eq(clinics.id, clinicId));
  const limitSeconds = row?.limit ?? null;
  if (limitSeconds === null) return { limitSeconds, usedSeconds: 0 };
  const used = await withClinic(db, clinicId, async (tx) => (await tx.execute(sql`
    select coalesce(sum(extract(epoch from (coalesce(ended_at, ${now}) - started_at))), 0)::float as s
    from calls where clinic_id = ${clinicId} and channel = 'web'`)).rows[0] as { s: number });
  return { limitSeconds, usedSeconds: Math.max(0, Math.round(Number(used.s))) };
}

/** Sets or clears (null) a clinic's test-call limit. For the hosting layer and self-hosters' scripts; staff cannot reach it. */
export async function setTestCallLimit(db: Database, clinicId: string, seconds: number | null): Promise<boolean> {
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < 0)) throw new Error('a test-call limit is a whole number of seconds, 0 or more');
  const rows = await db.update(clinics).set({ testSecondsLimit: seconds }).where(eq(clinics.id, clinicId)).returning({ id: clinics.id });
  return rows.length === 1;
}

/**
 * Gives a clinic at least `remainingSeconds` of browser test-call time still to use: the
 * limit becomes the time already used plus that, and never goes down. A clinic with no
 * limit keeps none. With `dryRun`, only says what would change. Null for an unknown clinic.
 */
export async function topUpTestCalls(db: Database, clinicId: string, remainingSeconds: number, now: Date, dryRun = false):
  Promise<{ limitSeconds: number | null; usedSeconds: number; newLimitSeconds: number | null; changed: boolean } | null> {
  if (!Number.isInteger(remainingSeconds) || remainingSeconds < 0) throw new Error('test-call time is a whole number of seconds, 0 or more');
  const [row] = await db.select({ id: clinics.id }).from(clinics).where(eq(clinics.id, clinicId));
  if (!row) return null;
  const { limitSeconds, usedSeconds } = await testCallAllowance(db, clinicId, now);
  if (limitSeconds === null) return { limitSeconds, usedSeconds, newLimitSeconds: null, changed: false };
  const newLimitSeconds = Math.max(limitSeconds, usedSeconds + remainingSeconds);
  const changed = newLimitSeconds !== limitSeconds;
  if (changed && !dryRun) await setTestCallLimit(db, clinicId, newLimitSeconds);
  return { limitSeconds, usedSeconds, newLimitSeconds, changed };
}

/** True the first time a webhook delivery id is seen, false for every retry after. */
export async function claimDelivery(db: Database, id: string, source: 'openai' | 'twilio'): Promise<boolean> {
  const rows = await db.insert(webhookDeliveries).values({ id, source }).onConflictDoNothing().returning({ id: webhookDeliveries.id });
  return rows.length === 1;
}

export async function saveClinic(db: Database, orgId: string, config: { id: string; name: string; timezone: string; phoneNumbers: string[] }) {
  await db.execute(sql`insert into organizations (id, name, slug) values (${orgId}, ${orgId}, ${orgId}) on conflict do nothing`);
  await db.execute(sql`insert into clinics (id, org_id, name, timezone, config) values (${config.id}, ${orgId}, ${config.name}, ${config.timezone}, ${JSON.stringify(config)}::jsonb)
    on conflict (id) do update set name = excluded.name, timezone = excluded.timezone, config = excluded.config`);
  for (const n of config.phoneNumbers) {
    await db.execute(sql`insert into phone_numbers (e164, clinic_id) values (${n}, ${config.id}) on conflict (e164) do update set clinic_id = excluded.clinic_id`);
  }
}

/** One line of a call's transcript as timings only: who spoke, when on the call's audio timeline, and how many characters. Never the text. */
export interface TimelineSegment { speaker: 'caller' | 'agent'; startMs: number; endMs: number; chars: number }

/**
 * A call's timeline, read-only, for timing the opening (2026-11): each stored line's speaker, start and end on
 * the audio timeline, and its length in characters, decrypted in memory to count them and never returned. The
 * clinic is found by trying each one in its own scope, as the tenancy rules require. Null when no clinic has the call.
 */
export async function callTimeline(db: Database, cipher: PhiCipher, callId: string): Promise<{ clinicId: string; channel: string; segments: TimelineSegment[] } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) throw new Error('a call id is a UUID');
  for (const { id: clinicId } of await db.select({ id: clinics.id }).from(clinics).orderBy(clinics.id)) {
    const found = await withClinic(db, clinicId, async (tx) => {
      const [call] = await tx.select({ channel: calls.channel }).from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.id, callId)));
      if (!call) return null;
      const ctx = phiContext(clinicId, 'call_segments.text');
      const rows = await tx.select({ speaker: callSegments.speaker, textEnc: callSegments.textEnc, startMs: callSegments.startMs, endMs: callSegments.endMs }).from(callSegments)
        .where(and(eq(callSegments.clinicId, clinicId), eq(callSegments.callId, callId))).orderBy(callSegments.startMs, callSegments.id);
      return { clinicId, channel: call.channel, segments: rows.map((r) => ({ speaker: r.speaker, startMs: r.startMs, endMs: r.endMs, chars: cipher.decrypt(r.textEnc, ctx).length })) };
    });
    if (found) return found;
  }
  return null;
}

/** The timeline's printout: a header, then one line a segment with the gap since the line before it ended. No text. */
export function formatCallTimeline(callId: string, t: { clinicId: string; channel: string; segments: TimelineSegment[] }): string[] {
  const lines = [`call ${callId} · clinic ${t.clinicId} · ${t.channel} · ${t.segments.length} segments`, 'speaker start_ms end_ms chars gap_ms'];
  let lastEnd: number | null = null;
  for (const s of t.segments) {
    lines.push(`${s.speaker} ${s.startMs} ${s.endMs} ${s.chars} ${lastEnd === null ? '-' : s.startMs - lastEnd}`);
    lastEnd = lastEnd === null ? s.endMs : Math.max(lastEnd, s.endMs);
  }
  return lines;
}
