// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditLog, TaskQueue, TaskType } from '@attendra/core';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, calls, clinicCounters, patients, tasks } from '../schema';
import { phoneKey } from './patients';

/**
 * The household a request belongs to: the record it is about, else the number the call came
 * from when a record is on that number (a number nobody is on is no household yet). Null for
 * a request written down with no record and no call.
 */
export async function householdOf(tx: Tx, cipher: PhiCipher, clinicId: string, patientId: string | null, callId: string | null): Promise<string | null> {
  if (patientId) {
    const [p] = await tx.select({ phoneHash: patients.phoneHash }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)));
    if (p?.phoneHash) return p.phoneHash;
  }
  if (!callId) return null;
  const [c] = await tx.select({ fromEnc: calls.fromEnc }).from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.id, callId)));
  if (!c?.fromEnc) return null;
  const hash = cipher.hash(phoneKey(clinicId, cipher.decrypt(c.fromEnc, phiContext(clinicId, 'calls.from'))));
  const [known] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, hash))).limit(1);
  return known ? hash : null;
}

/** The next request number at a clinic, taken in the caller's transaction: the counter row is locked, so two at once are consecutive. */
export async function nextRequestNumber(tx: Tx, clinicId: string): Promise<number> {
  const [row] = await tx.insert(clinicCounters).values({ clinicId, nextRequest: 2 })
    .onConflictDoUpdate({ target: clinicCounters.clinicId, set: { nextRequest: sql`${clinicCounters.nextRequest} + 1` } })
    .returning({ next: clinicCounters.nextRequest });
  return row!.next - 1;
}

export class PostgresTaskQueue implements TaskQueue {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher, private readonly actor = 'voice-agent') {}

  /**
   * Idempotent: the same key twice returns the first task, so a retried delegation cannot open two refills. The key
   * is looked for before a number is taken, so a retry costs no number; the number and the household go in with the row.
   */
  async create(clinicId: string, input: { type: TaskType; callId: string | null; patientId: string | null; idempotencyKey: string; details: Record<string, string>; urgent?: boolean; origin?: 'emergency' }) {
    return withClinic(this.db, clinicId, async (tx) => {
      const [existing] = await tx.select({ id: tasks.id, number: tasks.number }).from(tasks)
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.idempotencyKey, input.idempotencyKey)));
      if (existing) return { id: existing.id, number: existing.number, created: false };
      const householdHash = await householdOf(tx, this.cipher, clinicId, input.patientId, input.callId);
      const number = await nextRequestNumber(tx, clinicId);
      const [row] = await tx.insert(tasks).values({
        clinicId, number, householdHash, type: input.type, callId: input.callId, patientId: input.patientId,
        detailsEnc: this.cipher.encrypt(JSON.stringify(input.details), phiContext(clinicId, 'tasks.details')), idempotencyKey: input.idempotencyKey,
        ...(input.urgent ? { urgent: true } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        // a request someone at the clinic wrote down: who, for "Added by"
        ...(this.actor.startsWith('user:') ? { createdByUserId: this.actor.slice(5) } : {}),
      }).onConflictDoNothing().returning({ id: tasks.id });
      if (row) {
        await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: `task.created.${input.type}`, entity: 'task', entityId: row.id, counts: { number }, ...(input.callId ? { callId: input.callId } : {}) });
        return { id: row.id, number, created: true };
      }
      // the same key landed a moment before this one: theirs is the request (the number taken here stays unused)
      const [raced] = await tx.select({ id: tasks.id, number: tasks.number }).from(tasks)
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.idempotencyKey, input.idempotencyKey)));
      return { id: raced!.id, number: raced!.number, created: false };
    });
  }
}

export class PostgresAuditLog implements AuditLog {
  constructor(private readonly db: Database) {}

  async record(clinicId: string, entry: { actor: string; action: string; entity: string; entityId: string | null; callId?: string }) {
    await withClinic(this.db, clinicId, (tx) => tx.insert(auditLogs).values({ clinicId, ...entry }));
  }
}
