// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm';
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
  /** Why the front desk booked it outside the hours. */
  overrideReason: string | null;
  /** When the owner confirmed it (replied C to the reminder), and how. */
  confirmedAt: Date | null;
  confirmedVia: 'text' | 'staff' | null;
  reminderSentAt: Date | null;
}

const actorOf = (userId: string) => `user:${userId}`;
/** The most cancelled visits one name search reads before it filters: names are encrypted. */
const CANCELLED_SCAN = 5000;

/**
 * The schedule as the front desk reads it. Every read shows patient names, so every
 * read writes an audit row in the same transaction. A range is one row, not one per
 * appointment: "Jordan looked at next week", which is what happened.
 */
export class ScheduleRepository {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher) {}

  /**
   * The same range with no patient in it, for a viewer: when, with which vet, what kind of
   * visit and its state. Nothing is decrypted, so nothing is audited; patientId and
   * patientName are empty.
   */
  async rangeWithoutNames(clinicId: string, q: { from: Date; to: Date; providerId?: string | null; status?: 'booked' | 'cancelled' | 'all' }): Promise<ScheduleEntry[]> {
    const rows = await withClinic(this.db, clinicId, (tx) => tx.select({ a: appointments }).from(appointments)
      .where(and(eq(appointments.clinicId, clinicId), lt(appointments.startsAt, q.to), gt(appointments.endsAt, q.from),
        q.providerId ? eq(appointments.providerId, q.providerId) : undefined,
        q.status && q.status !== 'all' ? eq(appointments.status, q.status) : undefined))
      .orderBy(asc(appointments.startsAt), asc(appointments.id)));
    return (await this.entries(clinicId, rows.map((r) => ({ a: r.a, firstNameEnc: null, lastNameEnc: null })))).map((e) => ({ ...e, patientId: '' }));
  }

  /** Booked and cancelled appointments that overlap [from, to), so a visit already under way at `from` is shown too, earliest first. */
  async range(clinicId: string, q: { from: Date; to: Date; providerId?: string | null; status?: 'booked' | 'cancelled' | 'all'; label: string }, userId: string): Promise<ScheduleEntry[]> {
    const rows = await withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select({ a: appointments, firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc })
        .from(appointments).innerJoin(patients, eq(patients.id, appointments.patientId))
        .where(and(eq(appointments.clinicId, clinicId), lt(appointments.startsAt, q.to), gt(appointments.endsAt, q.from),
          q.providerId ? eq(appointments.providerId, q.providerId) : undefined,
          q.status && q.status !== 'all' ? eq(appointments.status, q.status) : undefined))
        .orderBy(asc(appointments.startsAt), asc(appointments.id));
      // a screen left open reads again on every change: the same range, filter and patients within 5 minutes is one row
      const key = `${q.label};provider=${q.providerId ?? 'all'};${q.status && q.status !== 'all' ? `status=${q.status};` : ''}${patientSetKey(rows.map((r) => r.a.patientId))}`;
      await recordView(tx, { clinicId, actor: actorOf(userId), action: 'schedule.viewed', entity: 'schedule', entityId: key }, 5);
      return rows;
    });
    return this.entries(clinicId, rows);
  }

  /**
   * Cancelled visits as a history: those due in [from, to), sorted by when the visit was
   * to be or by when it was cancelled, at most `limit`. `match` narrows by the patient's
   * name, after decrypting, so it reads more first. Audited as one view of the list.
   */
  async cancelled(clinicId: string, q: { from: Date; to: Date; providerId?: string | null; sort: 'visit' | 'cancelled'; order: 'newest' | 'oldest'; match?: (patientName: string) => boolean; label: string }, userId: string, limit = 200): Promise<{ entries: (ScheduleEntry & { cancelledAt: Date })[]; truncated: boolean }> {
    // by when it was cancelled, not its last change (a later edit of a cancelled row must not reorder the history)
    const column = q.sort === 'visit' ? appointments.startsAt : appointments.cancelledAt;
    const scan = q.match ? CANCELLED_SCAN : limit + 1;
    const rows = await withClinic(this.db, clinicId, (tx) => tx.select({ a: appointments, firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc })
      .from(appointments).innerJoin(patients, eq(patients.id, appointments.patientId))
      .where(and(eq(appointments.clinicId, clinicId), eq(appointments.status, 'cancelled'), lt(appointments.startsAt, q.to), gt(appointments.endsAt, q.from),
        q.providerId ? eq(appointments.providerId, q.providerId) : undefined))
      .orderBy(q.order === 'newest' ? desc(column) : asc(column), asc(appointments.id))
      .limit(scan));
    const all = (await this.entries(clinicId, rows)).map((e, i) => ({ ...e, cancelledAt: rows[i]!.a.cancelledAt ?? rows[i]!.a.updatedAt }));
    const kept = q.match ? all.filter((e) => q.match!(e.patientName)) : all;
    const shown = kept.slice(0, limit);
    // audited for the patients shown, not the ones read to find them
    await withClinic(this.db, clinicId, (tx) => recordView(tx, { clinicId, actor: actorOf(userId), action: 'schedule.viewed', entity: 'schedule', entityId: `cancelled:${q.label};provider=${q.providerId ?? 'all'};${patientSetKey(shown.map((e) => e.patientId))}` }, 5));
    return { entries: shown, truncated: kept.length > limit || rows.length >= scan };
  }

  /**
   * Some appointments by id, earliest first, with the patient's name: the "move or keep" list a change of hours shows
   * before it is saved. Audited as one view of those patients; with `named` false (a role without schedule:read),
   * no names, nothing decrypted, no audit row.
   */
  async visits(clinicId: string, ids: readonly string[], q: { label: string; named: boolean }, userId: string): Promise<ScheduleEntry[]> {
    if (!ids.length) return [];
    const where = and(eq(appointments.clinicId, clinicId), inArray(appointments.id, [...ids]));
    if (!q.named) {
      const rows = await withClinic(this.db, clinicId, (tx) => tx.select({ a: appointments }).from(appointments).where(where).orderBy(asc(appointments.startsAt), asc(appointments.id)));
      return (await this.entries(clinicId, rows.map((r) => ({ a: r.a, firstNameEnc: null, lastNameEnc: null })))).map((e) => ({ ...e, patientId: '' }));
    }
    const rows = await withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select({ a: appointments, firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc })
        .from(appointments).innerJoin(patients, eq(patients.id, appointments.patientId)).where(where).orderBy(asc(appointments.startsAt), asc(appointments.id));
      await recordView(tx, { clinicId, actor: actorOf(userId), action: 'schedule.viewed', entity: 'schedule', entityId: `${q.label};${patientSetKey(rows.map((r) => r.a.patientId))}` }, 5);
      return rows;
    });
    return this.entries(clinicId, rows);
  }

  /**
   * Visits a change of hours, days off, holidays or special days left outside any bookable time, kept where they are
   * by the person who saved it: nothing about them changes, and each is audited as kept by that person. Only visits
   * still booked and to come; returns how many.
   */
  async keepStranded(clinicId: string, ids: readonly string[], userId: string, now: Date): Promise<number> {
    if (!ids.length) return 0;
    return withClinic(this.db, clinicId, async (tx) => {
      const kept = await tx.select({ id: appointments.id }).from(appointments)
        .where(and(eq(appointments.clinicId, clinicId), inArray(appointments.id, [...ids]), eq(appointments.status, 'booked'), gt(appointments.startsAt, now)));
      if (kept.length) await tx.insert(auditLogs).values(kept.map((k) => ({ clinicId, actor: actorOf(userId), action: 'appointment.kept_outside_hours', entity: 'appointment', entityId: k.id })));
      return kept.length;
    });
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

  private async entries(clinicId: string, rows: { a: typeof appointments.$inferSelect; firstNameEnc: string | null; lastNameEnc: string | null }[]): Promise<ScheduleEntry[]> {
    const names = await staffNames(this.db, clinicId, rows.flatMap(({ a }) => [a.createdByUserId, a.cancelledByUserId].filter((x): x is string => !!x)));
    const by = (callId: string | null, userId: string | null): BookedBy | null =>
      callId ? { kind: 'assistant', callId } : userId ? { kind: 'staff', userId, name: names.get(userId) ?? null } : null;
    const ctx = (col: string) => phiContext(clinicId, col);
    return rows.map(({ a, firstNameEnc, lastNameEnc }) => ({
      id: a.id, patientId: a.patientId,
      patientName: firstNameEnc && lastNameEnc ? `${this.cipher.decrypt(firstNameEnc, ctx('patients.first_name'))} ${this.cipher.decrypt(lastNameEnc, ctx('patients.last_name'))}` : '',
      providerId: a.providerId, visitTypeId: a.visitTypeId, startsAt: a.startsAt, endsAt: a.endsAt, status: a.status,
      cancelReason: a.cancelReason, createdAt: a.createdAt,
      overrideReason: a.overrideReason, confirmedAt: a.confirmedAt, confirmedVia: a.confirmedVia, reminderSentAt: a.reminderSentAt,
      bookedBy: by(a.createdByCallId, a.createdByUserId)!,
      cancelledBy: a.status === 'cancelled' ? by(a.cancelledByCallId, a.cancelledByUserId) : null,
    }));
  }
}
