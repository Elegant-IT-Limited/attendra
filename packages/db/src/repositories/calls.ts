// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, callActions, calls, callSegments, clinics, phoneNumbers, webhookDeliveries } from '../schema';

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
      const fromHash = fromNumber ? this.cipher.hash(`${clinicId}|${fromNumber.replace(/\D/g, '').slice(-10)}`) : null;
      const [row] = await tx.insert(calls).values({ clinicId, openaiSessionId, fromHash, channel }).onConflictDoNothing().returning({ id: calls.id });
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

  async close(clinicId: string, callId: string, c: { reason: string; voiceSeconds: number | null; outcome: string; emergency: boolean }) {
    await withClinic(this.db, clinicId, async (tx) => {
      await tx.update(calls).set({
        endedAt: new Date(), closeReason: c.reason, voiceSeconds: c.voiceSeconds === null ? null : c.voiceSeconds.toFixed(2),
        outcome: c.outcome, emergencyFlag: c.emergency,
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
    .where(and(eq(phoneNumbers.e164, e164), eq(phoneNumbers.status, 'active')));
  return row?.config ?? null;
}

/** A clinic's stored config by id, for a test call started from the dashboard. Owner connection; no PHI. */
export async function clinicById(db: Database, clinicId: string): Promise<unknown | null> {
  const [row] = await db.select({ config: clinics.config }).from(clinics).where(eq(clinics.id, clinicId));
  return row?.config ?? null;
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
