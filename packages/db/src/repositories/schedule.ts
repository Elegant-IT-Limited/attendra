// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { appointments, auditLogs, patients } from '../schema';
import { patientSetKey, recordView, staffNames } from './audit';

export type BookedBy = { kind: 'assistant'; callId: string } | { kind: 'staff'; userId: string; name: string | null };

export interface ScheduleEntry {
  id: string;
  patientId: string;
  patientName: string;
  providerId: string;
  visitTypeId: string;
  startsAt: Date;
  endsAt: Date;
  status: 'booked' | 'cancelled';
  cancelReason: string | null;
  bookedBy: BookedBy;
  cancelledBy: BookedBy | null;
  createdAt: Date;
}

const actorOf = (userId: string) => `user:${userId}`;

/**
 * The schedule as the front desk reads it. Every read shows patient names, so every
 * read writes an audit row in the same transaction. A range is one row, not one per
 * appointment: "Jordan looked at next week", which is what happened.
 */
export class ScheduleRepository {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher) {}

  /** Booked and cancelled appointments that start in [from, to), earliest first. */
  async range(clinicId: string, q: { from: Date; to: Date; providerId?: string | null; label: string }, userId: string): Promise<ScheduleEntry[]> {
    const rows = await withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select({ a: appointments, firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc })
        .from(appointments).innerJoin(patients, eq(patients.id, appointments.patientId))
        .where(and(eq(appointments.clinicId, clinicId), lt(appointments.startsAt, q.to), gt(appointments.endsAt, q.from),
          q.providerId ? eq(appointments.providerId, q.providerId) : undefined))
        .orderBy(asc(appointments.startsAt), asc(appointments.id));
      // a screen left open refreshes every 30 seconds: the same range, filter and patients within 5 minutes is one row
      const key = `${q.label};provider=${q.providerId ?? 'all'};${patientSetKey(rows.map((r) => r.a.patientId))}`;
      await recordView(tx, { clinicId, actor: actorOf(userId), action: 'schedule.viewed', entity: 'schedule', entityId: key }, 5);
      return rows;
    });
    return this.entries(clinicId, rows);
  }

  /** One appointment with the patient's contact details and the note. Audited as a PHI view. */
  async appointment(clinicId: string, appointmentId: string, userId: string) {
    const found = await withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select({ a: appointments, p: patients }).from(appointments).innerJoin(patients, eq(patients.id, appointments.patientId))
        .where(and(eq(appointments.clinicId, clinicId), eq(appointments.id, appointmentId)));
      if (!row) return null;
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'appointment.viewed', entity: 'appointment', entityId: appointmentId, callId: row.a.createdByCallId });
      return row;
    });
    if (!found) return null;
    const { a, p } = found;
    const [entry] = await this.entries(clinicId, [{ a, firstNameEnc: p.firstNameEnc, lastNameEnc: p.lastNameEnc }]);
    const ctx = (col: string) => phiContext(clinicId, col);
    return {
      ...entry!,
      updatedAt: a.updatedAt,
      note: a.noteEnc ? this.cipher.decrypt(a.noteEnc, ctx('appointments.note')) : null,
      patient: {
        id: p.id,
        firstName: this.cipher.decrypt(p.firstNameEnc, ctx('patients.first_name')),
        lastName: this.cipher.decrypt(p.lastNameEnc, ctx('patients.last_name')),
        dob: this.cipher.decrypt(p.dobEnc, ctx('patients.dob')),
        phone: p.phoneEnc ? this.cipher.decrypt(p.phoneEnc, ctx('patients.phone')) : null,
      },
    };
  }

  private async entries(clinicId: string, rows: { a: typeof appointments.$inferSelect; firstNameEnc: string; lastNameEnc: string }[]): Promise<ScheduleEntry[]> {
    const names = await staffNames(this.db, clinicId, rows.flatMap(({ a }) => [a.createdByUserId, a.cancelledByUserId].filter((x): x is string => !!x)));
    const by = (callId: string | null, userId: string | null): BookedBy | null =>
      callId ? { kind: 'assistant', callId } : userId ? { kind: 'staff', userId, name: names.get(userId) ?? null } : null;
    const ctx = (col: string) => phiContext(clinicId, col);
    return rows.map(({ a, firstNameEnc, lastNameEnc }) => ({
      id: a.id, patientId: a.patientId,
      patientName: `${this.cipher.decrypt(firstNameEnc, ctx('patients.first_name'))} ${this.cipher.decrypt(lastNameEnc, ctx('patients.last_name'))}`,
      providerId: a.providerId, visitTypeId: a.visitTypeId, startsAt: a.startsAt, endsAt: a.endsAt, status: a.status,
      cancelReason: a.cancelReason, createdAt: a.createdAt,
      bookedBy: by(a.createdByCallId, a.createdByUserId)!,
      cancelledBy: a.status === 'cancelled' ? by(a.cancelledByCallId, a.cancelledByUserId) : null,
    }));
  }
}
