// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, type ClinicConfig, localDateOf, zonedInstant } from '@attendra/core';
import { type Database, type PhiCipher, phiContext, schema, type Tx, withClinic } from '@attendra/db';
import { and, eq, gt, lt, ne } from 'drizzle-orm';
import { type SlotProblem, slotProblem } from './rules';
import { byKey, insertAppointment, isConstraint } from './write';

const { appointments, auditLogs, patients } = schema;

export type CancelReason = 'patient_asked' | 'clinic_asked' | 'booked_in_error' | 'other';

export type StaffChange =
  | { status: 'done' | 'already_done'; appointmentId: string }
  | { status: 'refused'; reason: SlotProblem | 'cancelled' | 'just_cancelled' | 'idempotency_mismatch' }
  /** The patient is already booked, with any provider, at an overlapping time. */
  | { status: 'refused'; reason: 'patient_busy'; patientName: string }
  | { status: 'not_found' };

const actorOf = (userId: string) => `user:${userId}`;

/**
 * Booking, moving and cancelling from the dashboard. The rules are the assistant's
 * (slotProblem is the same search find_slots runs) and the write is the assistant's
 * (insertAppointment), so the front desk cannot book a time the phone would refuse.
 *
 * Every change is idempotent: a booking by its key, a move to where the appointment
 * already is, and a cancel of one already cancelled all answer 'already_done' and
 * write nothing, so a double click or a retried request changes nothing twice. A key
 * sent again with a different patient, provider, visit or time is a mistake, not a
 * retry, and is refused. Moves and cancels only change a row that is still booked,
 * so one that was cancelled a moment ago by someone else, or by the assistant, is
 * reported as just cancelled instead of being moved back to life.
 */
export class StaffScheduler {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher, private readonly now = () => new Date()) {}

  async book(clinic: ClinicConfig, input: { patientId: string; providerId: string; visitTypeId: string; start: Date; note?: string | null; idempotencyKey: string }, userId: string): Promise<StaffChange> {
    const key = `staff:${userId}:${input.idempotencyKey}`;
    const existing = await byKey(this.db, clinic.id, key);
    if (existing) {
      const same = existing.patientId === input.patientId && existing.providerId === input.providerId && existing.visitTypeId === input.visitTypeId
        && existing.startsAt.getTime() === input.start.getTime();
      return same ? { status: 'already_done', appointmentId: existing.id } : { status: 'refused', reason: 'idempotency_mismatch' };
    }
    const visitType = clinic.visitTypes.find((v) => v.id === input.visitTypeId);
    const check = await withClinic(this.db, clinic.id, async (tx) => {
      const [patient] = await tx.select().from(patients).where(and(eq(patients.clinicId, clinic.id), eq(patients.id, input.patientId)));
      if (!patient) return { kind: 'no_patient' } as const;
      const problem = slotProblem(clinic, await this.busy(tx, clinic, input.providerId, input.start), input, this.now());
      if (problem) return { kind: 'problem', problem } as const;
      const end = new Date(input.start.getTime() + (visitType?.minutes ?? 0) * 60_000);
      if (await this.patientBusy(tx, clinic.id, input.patientId, input.start, end)) {
        await this.auditBusy(tx, clinic.id, input.patientId, userId);
        return { kind: 'busy', name: this.nameOf(clinic.id, patient) } as const;
      }
      return null;
    });
    if (check?.kind === 'no_patient') return { status: 'not_found' };
    if (check?.kind === 'problem') return { status: 'refused', reason: check.problem };
    if (check?.kind === 'busy') return { status: 'refused', reason: 'patient_busy', patientName: check.name };
    const note = input.note?.trim();
    const result = await insertAppointment(this.db, clinic.id, {
      patientId: input.patientId, providerId: input.providerId, visitTypeId: input.visitTypeId,
      startsAt: input.start, endsAt: new Date(input.start.getTime() + visitType!.minutes * 60_000),
      idempotencyKey: key, createdByUserId: userId,
      noteEnc: note ? this.cipher.encrypt(note, phiContext(clinic.id, 'appointments.note')) : null,
    }, { actor: actorOf(userId), action: 'appointment.booked.staff' });
    if (result.status === 'slot_taken') return { status: 'refused', reason: 'taken' };
    return { status: result.status === 'booked' ? 'done' : 'already_done', appointmentId: result.row.id };
  }

  /** Moves a booking to a new time, and optionally a new provider. The appointment keeps its id, its patient and its visit type. */
  async reschedule(clinic: ClinicConfig, appointmentId: string, input: { start: Date; providerId?: string | null }, userId: string): Promise<StaffChange> {
    try {
      return await withClinic(this.db, clinic.id, async (tx) => {
        const [row] = await tx.select().from(appointments).where(and(eq(appointments.clinicId, clinic.id), eq(appointments.id, appointmentId)));
        if (!row) return { status: 'not_found' } as const;
        if (row.status === 'cancelled') return { status: 'refused', reason: 'cancelled' } as const;
        const providerId = input.providerId ?? row.providerId;
        if (providerId === row.providerId && input.start.getTime() === row.startsAt.getTime()) return { status: 'already_done', appointmentId } as const;
        if (row.startsAt.getTime() <= this.now().getTime()) return { status: 'refused', reason: 'past' } as const;
        const problem = slotProblem(clinic, await this.busy(tx, clinic, providerId, input.start, row.id), { providerId, visitTypeId: row.visitTypeId, start: input.start }, this.now());
        if (problem) return { status: 'refused', reason: problem } as const;
        const minutes = (row.endsAt.getTime() - row.startsAt.getTime()) / 60_000;
        const end = new Date(input.start.getTime() + minutes * 60_000);
        if (await this.patientBusy(tx, clinic.id, row.patientId, input.start, end, row.id)) {
          const [patient] = await tx.select().from(patients).where(and(eq(patients.clinicId, clinic.id), eq(patients.id, row.patientId)));
          await this.auditBusy(tx, clinic.id, row.patientId, userId);
          return { status: 'refused', reason: 'patient_busy', patientName: this.nameOf(clinic.id, patient!) } as const;
        }
        // only a row that is still booked: someone may have cancelled it since it was read
        const moved = await tx.update(appointments).set({ providerId, startsAt: input.start, endsAt: end, updatedAt: new Date() })
          .where(and(eq(appointments.id, row.id), eq(appointments.status, 'booked'))).returning({ id: appointments.id });
        if (!moved.length) return { status: 'refused', reason: 'just_cancelled' } as const;
        await tx.insert(auditLogs).values({ clinicId: clinic.id, actor: actorOf(userId), action: 'appointment.rescheduled.staff', entity: 'appointment', entityId: row.id });
        return { status: 'done', appointmentId } as const;
      });
    } catch (err) {
      // someone took the new time between the check and the move
      if (isConstraint(err, '23P01')) return { status: 'refused', reason: 'taken' };
      throw err;
    }
  }

  async cancel(clinic: ClinicConfig, appointmentId: string, input: { reason?: CancelReason | null }, userId: string): Promise<StaffChange> {
    return withClinic(this.db, clinic.id, async (tx) => {
      // one conditional update, so a cancel racing another cancel, or a move, changes the row once
      const cancelled = await tx.update(appointments).set({
        status: 'cancelled', cancelledByUserId: userId, cancelReason: input.reason ?? null, updatedAt: new Date(),
        // like the assistant's cancels, a staff cancel carries a key, so a retry of it is recognised as one
        cancelKey: `staff:${userId}:${appointmentId}`,
      }).where(and(eq(appointments.clinicId, clinic.id), eq(appointments.id, appointmentId), eq(appointments.status, 'booked'), gt(appointments.startsAt, this.now())))
        .returning({ id: appointments.id });
      if (cancelled.length) {
        await tx.insert(auditLogs).values({ clinicId: clinic.id, actor: actorOf(userId), action: 'appointment.cancelled.staff', entity: 'appointment', entityId: appointmentId });
        return { status: 'done', appointmentId } as const;
      }
      const [row] = await tx.select().from(appointments).where(and(eq(appointments.clinicId, clinic.id), eq(appointments.id, appointmentId)));
      if (!row) return { status: 'not_found' } as const;
      if (row.status === 'cancelled') return { status: 'already_done', appointmentId } as const;
      return { status: 'refused', reason: 'past' } as const;
    });
  }

  /** Whether the patient already has a booked appointment, with any provider, that overlaps [start, end). */
  private async patientBusy(tx: Tx, clinicId: string, patientId: string, start: Date, end: Date, except?: string) {
    const [clash] = await tx.select({ id: appointments.id }).from(appointments).where(and(
      eq(appointments.clinicId, clinicId), eq(appointments.patientId, patientId), eq(appointments.status, 'booked'),
      lt(appointments.startsAt, end), gt(appointments.endsAt, start), except ? ne(appointments.id, except) : undefined,
    )).limit(1);
    return !!clash;
  }

  /** A patient_busy refusal shows the patient's name, which is decrypted for it: a PHI read. */
  private async auditBusy(tx: Tx, clinicId: string, patientId: string, userId: string) {
    await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.busy.shown', entity: 'patient', entityId: patientId });
  }

  private nameOf(clinicId: string, p: typeof patients.$inferSelect) {
    const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
    return `${this.cipher.decrypt(p.firstNameEnc, ctx('first_name'))} ${this.cipher.decrypt(p.lastNameEnc, ctx('last_name'))}`;
  }

  /** Booked time for one provider on the local day of `start`, leaving out the appointment being moved. */
  private async busy(tx: Tx, clinic: ClinicConfig, providerId: string, start: Date, except?: string) {
    const date = localDateOf(start, clinic.timezone);
    const from = zonedInstant(date, '00:00', clinic.timezone);
    const to = zonedInstant(addDays(date, 1), '00:00', clinic.timezone);
    const rows = await tx.select({ providerId: appointments.providerId, start: appointments.startsAt, end: appointments.endsAt }).from(appointments).where(and(
      eq(appointments.clinicId, clinic.id), eq(appointments.status, 'booked'), eq(appointments.providerId, providerId),
      lt(appointments.startsAt, to), gt(appointments.endsAt, from), except ? ne(appointments.id, except) : undefined,
    ));
    return rows;
  }
}
