// SPDX-License-Identifier: AGPL-3.0-only
import type { Gender } from '@attendra/core';
import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { appointments, auditLogs, calls, patients, patientSearchKeys, smsMessages, tasks } from '../schema';
import { findSameIdentity, readGenderColumn, sealPatient, writeSearchKeys } from './patients';

/**
 * Deleting and merging patient records (DATA-5; docs/hipaa.md, "Deleting and merging patient records").
 *
 * A record is a pet (or a person) on file; its household is every record on the same phone number: one number, one
 * owner, every pet with that number is that owner's. Staff with patients:merge (owners and practice managers) merge
 * two records of one pet, merge two households of one owner (two numbers, or a typo), and delete a pet or a whole
 * household, each after a preview of what moves or goes. Everything runs inside the clinic's row security: a record
 * of another clinic is never found.
 *
 * Delete. The record keeps its row, emptied: every encrypted column is replaced by a fixed placeholder ("Deleted
 * record", a birthday of 1900-01-01) or cleared, every keyed hash is cleared or made unmatchable, its search keys go,
 * and texting consent goes with them. The row stays because its visits stay: the visits that took place, were missed
 * or were cancelled are counted in Quality and in the vets' history, and an appointment must point at a record. A
 * visit still to come is cancelled. Each visit's note goes. Its requests keep their number, type and outcome with
 * their details and notes removed. Calls are unlinked from it (the call records follow the clinic's retention
 * period, like every call); texts are unlinked (they hold a hash of the number, never the number).
 *
 * Merge. Everything that pointed at the record merged away moves to the record kept (appointments, calls' links,
 * requests, texts), the record kept fills its gaps from the other (kind, gender, the clinic's own fields, a yes to
 * texts), and the record merged away is deleted outright. A household merge puts every pet of the other number under
 * the number and owner kept, re-encrypting their details and re-hashing their search keys through the one cipher; a
 * pet that is on both numbers becomes one record. Encrypted values are decrypted and encrypted only through the
 * PhiCipher, never logged, and the audit rows say who, when, which ids and how many, never what.
 */

/** The placeholder a deleted record shows wherever a past visit still names it. Not anyone's name. */
export const DELETED_NAME = { first: 'Deleted', last: 'record' } as const;
export const DELETED_DOB = '1900-01-01';

export type RemovalScope = 'pet' | 'household';
export type MergeKind = 'pet' | 'household';

export interface DeleteCounts {
  /** Records deleted: 1 for a pet, every record on the number for a household. */
  records: number;
  /** Visits still to come, cancelled. */
  upcomingCancelled: number;
  /** Visits that have been (or were cancelled before), kept with no name for the counts. */
  visitsKept: number;
  /** Requests whose details and notes are removed. */
  requests: number;
  /** Calls no longer linked to the record. */
  callsUnlinked: number;
}

export interface MergeCounts {
  /** Records merged away: 1 for a pet, every record of the other number for a household. */
  records: number;
  /** In a household merge, pets on both numbers that became one record. */
  duplicates: number;
  appointments: number;
  calls: number;
  requests: number;
  texts: number;
}

export type MergeProblem = 'not_found' | 'same_record' | 'same_household' | 'different_household_needed' | 'no_phone';

const actorOf = (userId: string) => `user:${userId}`;
const live = (clinicId: string) => and(eq(patients.clinicId, clinicId), isNull(patients.deletedAt));

export class PatientRemoval {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher) {}

  private ctx(clinicId: string, col: string) { return phiContext(clinicId, `patients.${col}`); }

  /** The records a delete or merge acts on: the one record, or everyone on its number. Never a deleted one. */
  private async scope(tx: Tx, clinicId: string, patientId: string, scope: RemovalScope) {
    const [row] = await tx.select().from(patients).where(and(live(clinicId), eq(patients.id, patientId)));
    if (!row) return null;
    if (scope === 'pet' || !row.phoneHash) return [row];
    return tx.select().from(patients).where(and(live(clinicId), eq(patients.phoneHash, row.phoneHash)));
  }

  private async deleteCounts(tx: Tx, clinicId: string, ids: string[], now: Date): Promise<DeleteCounts> {
    const n = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
    const count = sql<number>`count(*)::int`;
    return {
      records: ids.length,
      upcomingCancelled: await n(tx.select({ n: count }).from(appointments).where(and(eq(appointments.clinicId, clinicId), inArray(appointments.patientId, ids), eq(appointments.status, 'booked'), gt(appointments.startsAt, now)))),
      visitsKept: await n(tx.select({ n: count }).from(appointments).where(and(eq(appointments.clinicId, clinicId), inArray(appointments.patientId, ids), sql`not (${appointments.status} = 'booked' and ${appointments.startsAt} > ${now})`))),
      requests: await n(tx.select({ n: count }).from(tasks).where(and(eq(tasks.clinicId, clinicId), inArray(tasks.patientId, ids)))),
      callsUnlinked: await n(tx.select({ n: count }).from(calls).where(and(eq(calls.clinicId, clinicId), inArray(calls.patientId, ids)))),
    };
  }

  /** What deleting would do, as counts. Null when the record is not this clinic's (or already deleted). Nothing is read in clear. */
  async previewDelete(clinicId: string, patientId: string, scope: RemovalScope, now: Date): Promise<DeleteCounts | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await this.scope(tx, clinicId, patientId, scope);
      return rows ? this.deleteCounts(tx, clinicId, rows.map((r) => r.id), now) : null;
    });
  }

  /**
   * Deletes a pet, or everyone on its number, as described above, in one transaction with one patient.deleted audit row
   * per record (counts only) and an appointment.cancelled.staff row per visit cancelled. Returns the counts and the ids
   * of the visits cancelled (for the webhooks), or null when there is no such record here.
   */
  async delete(clinicId: string, patientId: string, scope: RemovalScope, userId: string, now: Date): Promise<{ counts: DeleteCounts; cancelled: string[] } | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await this.scope(tx, clinicId, patientId, scope);
      if (!rows) return null;
      const ids = rows.map((r) => r.id);
      const counts = await this.deleteCounts(tx, clinicId, ids, now);
      const cancelled = (await tx.update(appointments).set({
        status: 'cancelled', cancelReason: 'other', cancelledByUserId: userId, updatedAt: now, cancelKey: sql`'deleted:' || ${appointments.id}::text`,
      }).where(and(eq(appointments.clinicId, clinicId), inArray(appointments.patientId, ids), eq(appointments.status, 'booked'), gt(appointments.startsAt, now)))
        .returning({ id: appointments.id })).map((r) => r.id);
      for (const id of cancelled) await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'appointment.cancelled.staff', entity: 'appointment', entityId: id });
      await tx.update(appointments).set({ noteEnc: null }).where(and(eq(appointments.clinicId, clinicId), inArray(appointments.patientId, ids), isNotNull(appointments.noteEnc)));
      const theirTasks = (await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.clinicId, clinicId), inArray(tasks.patientId, ids)))).map((t) => t.id);
      if (theirTasks.length) {
        await tx.update(tasks).set({ detailsEnc: this.cipher.encrypt('{}', phiContext(clinicId, 'tasks.details')), customEnc: null, householdHash: null })
          .where(and(eq(tasks.clinicId, clinicId), inArray(tasks.id, theirTasks)));
        await tx.update(tasks).set({ status: 'done', doneAt: now, doneByUserId: userId, outcome: 'not_needed' })
          .where(and(eq(tasks.clinicId, clinicId), inArray(tasks.id, theirTasks), eq(tasks.status, 'open')));
      }
      await tx.update(calls).set({ patientId: null }).where(and(eq(calls.clinicId, clinicId), inArray(calls.patientId, ids)));
      await tx.update(smsMessages).set({ patientId: null }).where(and(eq(smsMessages.clinicId, clinicId), inArray(smsMessages.patientId, ids)));
      await tx.delete(patientSearchKeys).where(and(eq(patientSearchKeys.clinicId, clinicId), inArray(patientSearchKeys.patientId, ids)));
      for (const r of rows) {
        await tx.update(patients).set({
          firstNameEnc: this.cipher.encrypt(DELETED_NAME.first, this.ctx(clinicId, 'first_name')),
          lastNameEnc: this.cipher.encrypt(DELETED_NAME.last, this.ctx(clinicId, 'last_name')),
          dobEnc: this.cipher.encrypt(DELETED_DOB, this.ctx(clinicId, 'dob')),
          // matches no lookup: no hash of anything a caller or the desk can type
          lookupHash: `deleted:${r.id}`,
          identityHash: null, phoneEnc: null, phoneHash: null, guardianNameEnc: null, genderEnc: null, speciesEnc: null, customEnc: null,
          ownerWordsHash: null, phoneSuffixHash: null, externalRef: null, smsConsentAt: null, smsConsentSource: null, status: 'active',
          deletedAt: now, deletedBy: userId,
        }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, r.id)));
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.deleted', entity: 'patient', entityId: r.id,
          counts: scope === 'household' ? { household: rows.length } : null });
      }
      // the notes on its requests, once the record is marked deleted: request notes are append-only, and this function
      // (migration 0054) removes only those of a deleted record's requests, in this clinic
      if (theirTasks.length) await tx.execute(sql`select delete_notes_of_deleted_patients(${`{${theirTasks.join(',')}}`}::uuid[])`);
      return { counts, cancelled };
    });
  }

  /** The household of a record: its number's hash, the number and the owner's name in clear (decrypted here, never returned to a caller of the API). */
  private household(clinicId: string, row: typeof patients.$inferSelect) {
    return {
      phoneHash: row.phoneHash,
      phone: row.phoneEnc ? this.cipher.decrypt(row.phoneEnc, this.ctx(clinicId, 'phone')) : null,
      owner: row.guardianNameEnc ? this.cipher.decrypt(row.guardianNameEnc, this.ctx(clinicId, 'guardian_name')) : null,
    };
  }

  private fieldsOf(clinicId: string, r: typeof patients.$inferSelect) {
    return {
      firstName: this.cipher.decrypt(r.firstNameEnc, this.ctx(clinicId, 'first_name')),
      lastName: this.cipher.decrypt(r.lastNameEnc, this.ctx(clinicId, 'last_name')),
      dob: this.cipher.decrypt(r.dobEnc, this.ctx(clinicId, 'dob')),
      gender: readGenderColumn(this.cipher, clinicId, r.genderEnc) as Gender | null,
      species: r.speciesEnc ? this.cipher.decrypt(r.speciesEnc, this.ctx(clinicId, 'species')) : null,
    };
  }

  private async check(tx: Tx, clinicId: string, kind: MergeKind, keepId: string, mergeId: string): Promise<{ problem: MergeProblem } | { keep: typeof patients.$inferSelect; merge: typeof patients.$inferSelect }> {
    if (keepId === mergeId) return { problem: 'same_record' };
    const rows = await tx.select().from(patients).where(and(live(clinicId), inArray(patients.id, [keepId, mergeId])));
    const keep = rows.find((r) => r.id === keepId);
    const merge = rows.find((r) => r.id === mergeId);
    if (!keep || !merge) return { problem: 'not_found' };
    if (kind === 'household') {
      if (!keep.phoneHash || !merge.phoneHash) return { problem: 'no_phone' };
      if (keep.phoneHash === merge.phoneHash) return { problem: 'same_household' };
    }
    return { keep, merge };
  }

  private async mergeCounts(tx: Tx, clinicId: string, ids: string[], duplicates = 0): Promise<MergeCounts> {
    const count = sql<number>`count(*)::int`;
    const n = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
    return {
      records: ids.length, duplicates,
      appointments: await n(tx.select({ n: count }).from(appointments).where(and(eq(appointments.clinicId, clinicId), inArray(appointments.patientId, ids)))),
      calls: await n(tx.select({ n: count }).from(calls).where(and(eq(calls.clinicId, clinicId), inArray(calls.patientId, ids)))),
      requests: await n(tx.select({ n: count }).from(tasks).where(and(eq(tasks.clinicId, clinicId), inArray(tasks.patientId, ids)))),
      texts: await n(tx.select({ n: count }).from(smsMessages).where(and(eq(smsMessages.clinicId, clinicId), inArray(smsMessages.patientId, ids)))),
    };
  }

  /**
   * A record of the other household as it will be on the number kept: that number, and in a pet clinic the owner kept
   * (and the owner's family name, which a pet's record carries); a person keeps their own name and guardian.
   */
  private moved(clinicId: string, keep: typeof patients.$inferSelect, b: typeof patients.$inferSelect, pets: boolean) {
    const kept = this.household(clinicId, keep);
    const f = this.fieldsOf(clinicId, b);
    if (pets) return { ...f, lastName: this.fieldsOf(clinicId, keep).lastName, phone: kept.phone!, guardianName: kept.owner };
    return { ...f, phone: kept.phone!, guardianName: b.guardianNameEnc ? this.cipher.decrypt(b.guardianNameEnc, this.ctx(clinicId, 'guardian_name')) : null };
  }

  /** The pets of the other household that are already on the kept one (the same name and birthday once moved), found through the cipher. */
  private async duplicatesOf(tx: Tx, clinicId: string, keep: typeof patients.$inferSelect, others: (typeof patients.$inferSelect)[], pets: boolean) {
    const pairs: { from: string; into: string }[] = [];
    for (const b of others) {
      const same = await findSameIdentity(tx, this.cipher, clinicId, this.moved(clinicId, keep, b, pets), b.id);
      if (same) pairs.push({ from: b.id, into: same });
    }
    return pairs;
  }

  /** What a merge would move, as counts, or why it cannot be done. Nothing changes. */
  async previewMerge(clinicId: string, kind: MergeKind, keepId: string, mergeId: string, pets = true): Promise<MergeCounts | { problem: MergeProblem }> {
    return withClinic(this.db, clinicId, async (tx) => {
      const found = await this.check(tx, clinicId, kind, keepId, mergeId);
      if ('problem' in found) return found;
      if (kind === 'pet') return this.mergeCounts(tx, clinicId, [mergeId]);
      const others = await tx.select().from(patients).where(and(live(clinicId), eq(patients.phoneHash, found.merge.phoneHash!)));
      return this.mergeCounts(tx, clinicId, others.map((o) => o.id), (await this.duplicatesOf(tx, clinicId, found.keep, others, pets)).length);
    });
  }

  /** One pet's record into another's, inside the caller's transaction: links moved, gaps filled, the other deleted. */
  private async mergePet(tx: Tx, clinicId: string, keep: typeof patients.$inferSelect, merge: typeof patients.$inferSelect) {
    const ids = [merge.id];
    await tx.update(appointments).set({ patientId: keep.id }).where(and(eq(appointments.clinicId, clinicId), inArray(appointments.patientId, ids)));
    await tx.update(calls).set({ patientId: keep.id }).where(and(eq(calls.clinicId, clinicId), inArray(calls.patientId, ids)));
    await tx.update(tasks).set({ patientId: keep.id, ...(keep.phoneHash ? { householdHash: keep.phoneHash } : {}) }).where(and(eq(tasks.clinicId, clinicId), inArray(tasks.patientId, ids)));
    await tx.update(smsMessages).set({ patientId: keep.id }).where(and(eq(smsMessages.clinicId, clinicId), inArray(smsMessages.patientId, ids)));
    // the record kept fills its gaps from the other: the same column of the same clinic is encrypted under the same context
    const custom = (r: typeof patients.$inferSelect) => (r.customEnc ? JSON.parse(this.cipher.decrypt(r.customEnc, this.ctx(clinicId, 'custom'))) as Record<string, string> : {});
    const values = { ...custom(merge), ...custom(keep) };
    await tx.update(patients).set({
      genderEnc: keep.genderEnc ?? merge.genderEnc,
      speciesEnc: keep.speciesEnc ?? merge.speciesEnc,
      customEnc: Object.keys(values).length ? this.cipher.encrypt(JSON.stringify(values), this.ctx(clinicId, 'custom')) : null,
      ...(keep.smsConsentAt ? {} : merge.smsConsentAt && merge.phoneHash === keep.phoneHash ? { smsConsentAt: merge.smsConsentAt, smsConsentSource: merge.smsConsentSource } : {}),
      status: keep.status === 'active' || merge.status === 'active' ? 'active' : 'new',
    }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, keep.id)));
    // gone, with its search keys (on delete cascade)
    await tx.delete(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, merge.id)));
  }

  /**
   * Merges, as described above, in one transaction. Audited with patient.merged (the record kept) and
   * patient.merged_away (each record merged away), or patient.household.merged, with counts only.
   */
  async merge(clinicId: string, kind: MergeKind, keepId: string, mergeId: string, userId: string, pets: boolean): Promise<MergeCounts | { problem: MergeProblem }> {
    return withClinic(this.db, clinicId, async (tx) => {
      const found = await this.check(tx, clinicId, kind, keepId, mergeId);
      if ('problem' in found) return found;
      const { keep, merge } = found;
      if (kind === 'pet') {
        const counts = await this.mergeCounts(tx, clinicId, [merge.id]);
        await this.mergePet(tx, clinicId, keep, merge);
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.merged', entity: 'patient', entityId: keep.id, counts: { ...counts } });
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.merged_away', entity: 'patient', entityId: merge.id });
        return counts;
      }
      const others = await tx.select().from(patients).where(and(live(clinicId), eq(patients.phoneHash, merge.phoneHash!)));
      const duplicates = await this.duplicatesOf(tx, clinicId, keep, others, pets);
      const counts = await this.mergeCounts(tx, clinicId, others.map((o) => o.id), duplicates.length);
      // the number kept's yes or no to texts: texts now go to it
      const [consent] = await tx.select({ at: patients.smsConsentAt, source: patients.smsConsentSource }).from(patients)
        .where(and(live(clinicId), eq(patients.phoneHash, keep.phoneHash!), isNotNull(patients.smsConsentAt))).limit(1);
      for (const b of others) {
        const dup = duplicates.find((d) => d.from === b.id);
        if (dup) {
          const [into] = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, dup.into)));
          await this.mergePet(tx, clinicId, into!, b);
          await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.merged_away', entity: 'patient', entityId: b.id });
          continue;
        }
        // one number, one owner: a pet clinic's pets take the owner kept; a person keeps their own parent or guardian
        const fields = this.moved(clinicId, keep, b, pets);
        await tx.update(patients).set({
          ...sealPatient(this.cipher, clinicId, fields),
          smsConsentAt: consent?.at ?? null, smsConsentSource: consent?.source ?? null,
        }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, b.id)));
        await writeSearchKeys(tx, this.cipher, clinicId, b.id, fields);
      }
      await tx.update(tasks).set({ householdHash: keep.phoneHash }).where(and(eq(tasks.clinicId, clinicId), eq(tasks.householdHash, merge.phoneHash!)));
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.household.merged', entity: 'patient', entityId: keep.id, counts: { ...counts } });
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.household.merged_away', entity: 'patient', entityId: merge.id, counts: { records: others.length } });
      return counts;
    });
  }
}

