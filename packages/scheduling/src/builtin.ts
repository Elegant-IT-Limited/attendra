// SPDX-License-Identifier: AGPL-3.0-only
import type { AppointmentSummary, BookingResult, SchedulerAdapter, Slot } from '@attendra/core';
import { type Database, schema, withClinic } from '@attendra/db';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { byKey, insertAppointment } from './write';

const { appointments, auditLogs } = schema;

const summary = (r: typeof appointments.$inferSelect): AppointmentSummary =>
  ({ id: r.id, providerId: r.providerId, visitTypeId: r.visitTypeId, start: r.startsAt, end: r.endsAt });

/**
 * The scheduler that ships in the box: appointments in Attendra's own Postgres.
 * EHR adapters (NexHealth first, FHIR later) implement the same SchedulerAdapter,
 * so the agent never knows which one it is talking to.
 */
export class BuiltinScheduler implements SchedulerAdapter {
  constructor(private readonly db: Database, private readonly actor = 'voice-agent') {}

  async busy(clinicId: string, providerIds: string[], from: Date, to: Date) {
    if (!providerIds.length) return [];
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select().from(appointments).where(and(
        eq(appointments.clinicId, clinicId), eq(appointments.status, 'booked'),
        inArray(appointments.providerId, providerIds), lt(appointments.startsAt, to), gt(appointments.endsAt, from),
      ));
      return rows.map((r) => ({ providerId: r.providerId, start: r.startsAt, end: r.endsAt }));
    });
  }

  /**
   * Idempotent and race-safe. The idempotency key makes a retry return the first
   * booking; the exclusion constraint in the schema makes two different callers
   * racing for one slot end with exactly one booking and one "slot_taken".
   */
  async book(clinicId: string, input: { patientId: string; slot: Slot; callId: string; idempotencyKey: string }): Promise<BookingResult> {
    const existing = await byKey(this.db, clinicId, input.idempotencyKey);
    if (existing) return { status: 'already_done', appointment: summary(existing) };
    const result = await insertAppointment(this.db, clinicId, {
      patientId: input.patientId, providerId: input.slot.providerId, visitTypeId: input.slot.visitTypeId,
      startsAt: input.slot.start, endsAt: input.slot.end, idempotencyKey: input.idempotencyKey, createdByCallId: input.callId,
    }, { actor: this.actor, action: 'appointment.booked', callId: input.callId });
    return result.status === 'slot_taken' ? result : { status: result.status, appointment: summary(result.row) };
  }

  async cancel(clinicId: string, input: { patientId: string; appointmentId: string; callId: string; idempotencyKey: string }) {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select().from(appointments).where(and(
        eq(appointments.clinicId, clinicId), eq(appointments.id, input.appointmentId), eq(appointments.patientId, input.patientId),
      ));
      if (!row) return { status: 'not_found' } as const; // includes someone else's appointment
      if (row.status === 'cancelled') return { status: row.cancelKey === input.idempotencyKey ? 'already_done' : 'not_found' } as const;
      await tx.update(appointments).set({ status: 'cancelled', cancelKey: input.idempotencyKey, cancelledByCallId: input.callId, updatedAt: new Date() })
        .where(eq(appointments.id, row.id));
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'appointment.cancelled', entity: 'appointment', entityId: row.id, callId: input.callId });
      return { status: 'cancelled' } as const;
    });
  }

  async upcoming(clinicId: string, patientId: string, now: Date) {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select().from(appointments).where(and(
        eq(appointments.clinicId, clinicId), eq(appointments.patientId, patientId), eq(appointments.status, 'booked'), gt(appointments.startsAt, now),
      )).orderBy(appointments.startsAt);
      return rows.map(summary);
    });
  }
}
