// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditLog, TaskQueue, TaskType } from '@attendra/core';
import { and, eq } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, tasks } from '../schema';

export class PostgresTaskQueue implements TaskQueue {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher, private readonly actor = 'voice-agent') {}

  /** Idempotent: the same key twice returns the first task, so a retried delegation cannot open two refills. */
  async create(clinicId: string, input: { type: TaskType; callId: string; patientId: string | null; idempotencyKey: string; details: Record<string, string> }) {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.insert(tasks).values({
        clinicId, type: input.type, callId: input.callId, patientId: input.patientId,
        detailsEnc: this.cipher.encrypt(JSON.stringify(input.details), phiContext(clinicId, 'tasks.details')), idempotencyKey: input.idempotencyKey,
      }).onConflictDoNothing().returning({ id: tasks.id });
      if (row) {
        await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: `task.created.${input.type}`, entity: 'task', entityId: row.id, callId: input.callId });
        return { id: row.id, created: true };
      }
      const [existing] = await tx.select({ id: tasks.id }).from(tasks)
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.idempotencyKey, input.idempotencyKey)));
      return { id: existing!.id, created: false };
    });
  }
}

export class PostgresAuditLog implements AuditLog {
  constructor(private readonly db: Database) {}

  async record(clinicId: string, entry: { actor: string; action: string; entity: string; entityId: string | null; callId?: string }) {
    await withClinic(this.db, clinicId, (tx) => tx.insert(auditLogs).values({ clinicId, ...entry }));
  }
}
