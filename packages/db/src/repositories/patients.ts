// SPDX-License-Identifier: AGPL-3.0-only
import { namesMatch, normalizeName, type PatientDirectory, type PatientLookup } from '@attendra/core';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, patients } from '../schema';

const lastName = (full: string) => normalizeName(full).split(' ').at(-1) ?? '';
// keyed per clinic, so the same person at two clinics does not share a lookup value
export const patientLookupKey = (clinicId: string, full: string, dob: string) => `${clinicId}|${lastName(full)}|${dob}`;
export const phoneKey = (clinicId: string, phone: string) => `${clinicId}|${phone.replace(/\D/g, '').slice(-10)}`;

export class PostgresPatientDirectory implements PatientDirectory {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher, private readonly actor = 'voice-agent') {}

  /**
   * Narrows by a keyed hash of last name and DOB, then decrypts only those few rows
   * to compare first names. Every successful lookup is a PHI access and is audited
   * in the same transaction.
   */
  async findByNameAndDob(clinicId: string, fullName: string, dob: string): Promise<PatientLookup> {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select().from(patients)
        .where(and(eq(patients.clinicId, clinicId), eq(patients.lookupHash, this.cipher.hash(patientLookupKey(clinicId, fullName, dob)))));
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      const matches = rows.filter((r) => namesMatch(fullName, `${this.cipher.decrypt(r.firstNameEnc, ctx('first_name'))} ${this.cipher.decrypt(r.lastNameEnc, ctx('last_name'))}`));
      if (matches.length > 1) return { status: 'ambiguous' } as const;
      const match = matches[0];
      if (!match) return { status: 'not_found' } as const;
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.identified', entity: 'patient', entityId: match.id });
      return { status: 'found', patient: {
        id: match.id,
        firstName: this.cipher.decrypt(match.firstNameEnc, ctx('first_name')),
        phone: match.phoneEnc ? this.cipher.decrypt(match.phoneEnc, ctx('phone')) : null,
      } } as const;
    });
  }

  /** For seeds, imports and tests. Stores only ciphertext and keyed hashes. */
  async create(clinicId: string, p: { firstName: string; lastName: string; dob: string; phone?: string }): Promise<string> {
    return withClinic(this.db, clinicId, async (tx) => {
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      const [row] = await tx.insert(patients).values({
        clinicId,
        lookupHash: this.cipher.hash(patientLookupKey(clinicId, `${p.firstName} ${p.lastName}`, p.dob)),
        firstNameEnc: this.cipher.encrypt(p.firstName, ctx('first_name')),
        lastNameEnc: this.cipher.encrypt(p.lastName, ctx('last_name')),
        dobEnc: this.cipher.encrypt(p.dob, ctx('dob')),
        phoneEnc: p.phone ? this.cipher.encrypt(p.phone, ctx('phone')) : null,
        phoneHash: p.phone ? this.cipher.hash(phoneKey(clinicId, p.phone)) : null,
      }).returning({ id: patients.id });
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.created', entity: 'patient', entityId: row!.id });
      return row!.id;
    });
  }
}

/**
 * Recomputes every patient's lookup hash from the stored name and date of birth,
 * after the name normaliser changes: until then a patient whose hash was made the
 * old way cannot be found. Safe to run more than once, and on any database, since it
 * only rewrites hashes that differ. Owner connection, one clinic at a time, with one
 * audit row per clinic that records how many changed.
 */
export async function rehashPatientLookups(db: Database, cipher: PhiCipher): Promise<{ checked: number; changed: number }> {
  let checked = 0;
  let changed = 0;
  const clinicIds = (await db.execute(sql`select id from clinics order by id`)).rows as { id: string }[];
  for (const { id: clinicId } of clinicIds) {
    await withClinic(db, clinicId, async (tx) => {
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      let n = 0;
      for (const r of await tx.select({ id: patients.id, lookupHash: patients.lookupHash, first: patients.firstNameEnc, last: patients.lastNameEnc, dob: patients.dobEnc }).from(patients).where(eq(patients.clinicId, clinicId))) {
        checked++;
        const hash = cipher.hash(patientLookupKey(clinicId, `${cipher.decrypt(r.first, ctx('first_name'))} ${cipher.decrypt(r.last, ctx('last_name'))}`, cipher.decrypt(r.dob, ctx('dob'))));
        if (hash === r.lookupHash) continue;
        await tx.update(patients).set({ lookupHash: hash }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, r.id)));
        n++;
      }
      changed += n;
      if (n) await tx.insert(auditLogs).values({ clinicId, actor: 'system', action: 'patient.lookups.rehashed', entity: 'clinic', entityId: clinicId, counts: { patients: n } });
    });
  }
  return { checked, changed };
}
