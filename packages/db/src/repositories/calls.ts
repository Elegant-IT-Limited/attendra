// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { callActions, calls, callSegments, clinics, phoneNumbers, webhookDeliveries } from '../schema';

/** The call record: transcript segments, every tool action, and the close-out. */
export class CallRepository {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher) {}

  /** One row per OpenAI session. A second accept for the same session returns the first call. */
  async open(clinicId: string, openaiSessionId: string, fromNumber: string | null): Promise<string> {
    return withClinic(this.db, clinicId, async (tx) => {
      const fromHash = fromNumber ? this.cipher.hash(`${clinicId}|${fromNumber.replace(/\D/g, '').slice(-10)}`) : null;
      const [row] = await tx.insert(calls).values({ clinicId, openaiSessionId, fromHash }).onConflictDoNothing().returning({ id: calls.id });
      if (row) return row.id;
      const [existing] = await tx.select({ id: calls.id }).from(calls).where(eq(calls.openaiSessionId, openaiSessionId));
      // RLS hides a session that belongs to another clinic; that is a routing bug, not a retry
      if (!existing) throw new Error('session id already used by another clinic');
      return existing.id;
    });
  }

  async appendSegment(clinicId: string, callId: string, s: { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }) {
    await withClinic(this.db, clinicId, (tx) => tx.insert(callSegments).values({
      clinicId, callId, speaker: s.speaker, textEnc: this.cipher.encrypt(s.text, phiContext(clinicId, 'call_segments.text')), startMs: s.startMs, endMs: s.endMs,
    }));
  }

  async recordAction(clinicId: string, callId: string, a: { tool: string; argsRedacted: unknown; result: unknown; idempotencyKey: string | null; taskRevision: number }) {
    await withClinic(this.db, clinicId, (tx) => tx.insert(callActions).values({ clinicId, callId, ...a }));
  }

  async close(clinicId: string, callId: string, c: { reason: string; voiceSeconds: number | null; outcome: string; emergency: boolean }) {
    await withClinic(this.db, clinicId, (tx) => tx.update(calls).set({
      endedAt: new Date(), closeReason: c.reason, voiceSeconds: c.voiceSeconds === null ? null : c.voiceSeconds.toFixed(2),
      outcome: c.outcome, emergencyFlag: c.emergency,
    }).where(and(eq(calls.id, callId), eq(calls.clinicId, clinicId))));
  }

  async transcript(clinicId: string, callId: string) {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select().from(callSegments).where(eq(callSegments.callId, callId)).orderBy(callSegments.startMs, callSegments.id);
      return rows.map((r) => ({ speaker: r.speaker, text: this.cipher.decrypt(r.textEnc, phiContext(clinicId, 'call_segments.text')), startMs: r.startMs }));
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

/** True the first time a webhook delivery id is seen, false for every retry after. */
export async function claimDelivery(db: Database, id: string, source: 'openai' | 'twilio'): Promise<boolean> {
  const rows = await db.insert(webhookDeliveries).values({ id, source }).onConflictDoNothing().returning({ id: webhookDeliveries.id });
  return rows.length === 1;
}

export async function saveClinic(db: Database, orgId: string, config: { id: string; name: string; timezone: string; phoneNumbers: string[] }) {
  await db.execute(sql`insert into organizations (id, name) values (${orgId}, ${orgId}) on conflict do nothing`);
  await db.execute(sql`insert into clinics (id, org_id, name, timezone, config) values (${config.id}, ${orgId}, ${config.name}, ${config.timezone}, ${JSON.stringify(config)}::jsonb)
    on conflict (id) do update set name = excluded.name, timezone = excluded.timezone, config = excluded.config`);
  for (const n of config.phoneNumbers) {
    await db.execute(sql`insert into phone_numbers (e164, clinic_id) values (${n}, ${config.id}) on conflict (e164) do update set clinic_id = excluded.clinic_id`);
  }
}
