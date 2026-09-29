// SPDX-License-Identifier: AGPL-3.0-only
import { type Database, schema, withClinic } from '@attendra/db';
import { and, eq } from 'drizzle-orm';

const { appointments, auditLogs } = schema;

export type AppointmentRow = typeof appointments.$inferSelect;

/**
 * The one way an appointment is written, for the assistant and the front desk
 * alike: the row and its audit entry in one transaction. The exclusion constraint
 * in the schema is what finally stops a double booking, so two people racing for
 * one slot end with one booking and one 'slot_taken', whoever they are.
 */
export async function insertAppointment(
  db: Database,
  clinicId: string,
  values: Omit<typeof appointments.$inferInsert, 'clinicId'>,
  audit: { actor: string; action: string; callId?: string | null },
): Promise<{ status: 'booked'; row: AppointmentRow } | { status: 'slot_taken' } | { status: 'already_done'; row: AppointmentRow }> {
  try {
    return await withClinic(db, clinicId, async (tx) => {
      const [row] = await tx.insert(appointments).values({ ...values, clinicId }).returning();
      await tx.insert(auditLogs).values({ clinicId, actor: audit.actor, action: audit.action, entity: 'appointment', entityId: row!.id, callId: audit.callId ?? null });
      return { status: 'booked', row: row! } as const;
    });
  } catch (err) {
    if (isConstraint(err, '23P01')) return { status: 'slot_taken' }; // exclusion_violation
    if (isConstraint(err, '23505')) { // the same idempotency key won a race with us
      const again = await byKey(db, clinicId, values.idempotencyKey);
      if (again) return { status: 'already_done', row: again };
    }
    throw err;
  }
}

export async function byKey(db: Database, clinicId: string, key: string): Promise<AppointmentRow | undefined> {
  return withClinic(db, clinicId, async (tx) => {
    const [row] = await tx.select().from(appointments).where(and(eq(appointments.clinicId, clinicId), eq(appointments.idempotencyKey, key)));
    return row;
  });
}

export function isConstraint(err: unknown, code: string): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === code || e?.cause?.code === code;
}
