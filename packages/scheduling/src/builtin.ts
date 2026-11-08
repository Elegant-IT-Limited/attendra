// SPDX-License-Identifier: AGPL-3.0-only
import { type AppointmentSummary, type BookingResult, HOLDS_TIME, type SchedulerAdapter, type Slot } from '@attendra/core';
import { type Database, type PhiCipher, phiContext, schema, withClinic } from '@attendra/db';
import { and, eq, gt, inArray, lt, ne } from 'drizzle-orm';
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
  /** With `cipher`, a booking's note for the team is kept on the appointment, encrypted; without it, none is kept. */
  constructor(private readonly db: Database, private readonly actor = 'voice-agent', private readonly cipher?: PhiCipher) {}

  async busy(clinicId: string, providerIds: string[], from: Date, to: Date) {
    if (!providerIds.length) return [];
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select().from(appointments).where(and(
        eq(appointments.clinicId, clinicId), inArray(appointments.status, [...HOLDS_TIME]),
        inArray(appointments.providerId, providerIds), lt(appointments.startsAt, to), gt(appointments.endsAt, from),
      ));
      return rows.map((r) => ({ providerId: r.providerId, start: r.startsAt, end: r.endsAt, visitTypeId: r.visitTypeId }));
    });
  }

  /**
   * Idempotent and race-safe. The idempotency key makes a retry return the first
   * booking; the exclusion constraint in the schema makes two different callers
   * racing for one slot end with exactly one booking and one "slot_taken". A patient
   * who already has a visit then, with any provider, is refused as the front desk
   * refuses them: "patient_busy".
   */
  async book(clinicId: string, input: { patientId: string; slot: Slot; callId: string; idempotencyKey: string; replacesAppointmentId?: string | null; note?: string | null }): Promise<BookingResult> {
    const existing = await byKey(this.db, clinicId, input.idempotencyKey);
    if (existing) return { status: 'already_done', appointment: summary(existing) };
    const busy = await withClinic(this.db, clinicId, async (tx) => (await tx.select({ id: appointments.id }).from(appointments).where(and(
      eq(appointments.clinicId, clinicId), eq(appointments.patientId, input.patientId), inArray(appointments.status, [...HOLDS_TIME]),
      lt(appointments.startsAt, input.slot.end), gt(appointments.endsAt, input.slot.start),
      input.replacesAppointmentId ? ne(appointments.id, input.replacesAppointmentId) : undefined,
    )).limit(1)).length > 0);
    if (busy) return { status: 'patient_busy' };
    // a move cancels the visit it replaces in the same step, so a new visit that overlaps it with the same provider (the
    // same time, another kind of visit) can be booked; if the new one fails, the old one stays
    let replaced = false;
    const replaces = input.replacesAppointmentId;
    const result = await insertAppointment(this.db, clinicId, {
      patientId: input.patientId, providerId: input.slot.providerId, visitTypeId: input.slot.visitTypeId,
      startsAt: input.slot.start, endsAt: input.slot.end, idempotencyKey: input.idempotencyKey, createdByCallId: input.callId,
      noteEnc: input.note?.trim() && this.cipher ? this.cipher.encrypt(input.note.trim(), phiContext(clinicId, 'appointments.note')) : null,
    }, { actor: this.actor, action: 'appointment.booked', callId: input.callId }, replaces ? async (tx) => {
      const done = await tx.update(appointments).set({ status: 'cancelled', cancelKey: `replaced:${input.idempotencyKey}`, cancelledByCallId: input.callId, updatedAt: new Date(), cancelledAt: new Date() })
        .where(and(eq(appointments.clinicId, clinicId), eq(appointments.id, replaces), eq(appointments.patientId, input.patientId), eq(appointments.status, 'booked')))
        .returning({ id: appointments.id });
      if (done.length) await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'appointment.cancelled', entity: 'appointment', entityId: replaces, callId: input.callId });
      replaced = done.length > 0;
    } : undefined);
    if (result.status === 'slot_taken') return result;
    return result.status === 'booked' ? { status: 'booked', appointment: summary(result.row), ...(replaced ? { replaced } : {}) } : { status: result.status, appointment: summary(result.row) };
  }

  async cancel(clinicId: string, input: { patientId: string; appointmentId: string; callId: string; idempotencyKey: string }) {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select().from(appointments).where(and(
        eq(appointments.clinicId, clinicId), eq(appointments.id, input.appointmentId), eq(appointments.patientId, input.patientId),
      ));
      if (!row) return { status: 'not_found' } as const; // includes someone else's appointment
      if (row.status === 'cancelled') return { status: row.cancelKey === input.idempotencyKey ? 'already_done' : 'not_found' } as const;
      // only a booked row is cancelled: of two cancels that both read it as booked, one wins
      const done = await tx.update(appointments).set({ status: 'cancelled', cancelKey: input.idempotencyKey, cancelledByCallId: input.callId, updatedAt: new Date(), cancelledAt: new Date() })
        .where(and(eq(appointments.clinicId, clinicId), eq(appointments.id, row.id), eq(appointments.status, 'booked'))).returning({ id: appointments.id });
      if (!done.length) return { status: 'not_found' } as const;
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

  /** Past visits that took place (booked, arrived or completed; not a no-show, not cancelled), for the patient's usual provider and their last visit: the last two years. */
  async history(clinicId: string, patientId: string, now: Date) {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select({ providerId: appointments.providerId, start: appointments.startsAt, visitTypeId: appointments.visitTypeId }).from(appointments).where(and(
        eq(appointments.clinicId, clinicId), eq(appointments.patientId, patientId), inArray(appointments.status, [...HOLDS_TIME]),
        lt(appointments.startsAt, now), gt(appointments.startsAt, new Date(now.getTime() - 730 * 86_400_000)),
      ));
      return rows;
    });
  }
}
