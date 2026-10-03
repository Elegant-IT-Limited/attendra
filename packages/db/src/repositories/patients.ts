// SPDX-License-Identifier: AGPL-3.0-only
import { type CallPatient, namesMatch, normalizeName, type PatientDirectory, type PatientLookup, type Registration } from '@attendra/core';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, patients } from '../schema';

const lastName = (full: string) => normalizeName(full).split(' ').at(-1) ?? '';
const firstName = (full: string) => normalizeName(full).split(' ')[0] ?? '';
/** The digits a phone number is compared on: the last 10, so +1 (303) 555-0100 equals 3035550100. */
export const phoneDigits = (phone: string) => phone.replace(/\D/g, '').slice(-10);
// keyed per clinic, so the same person at two clinics does not share a lookup value
export const patientLookupKey = (clinicId: string, full: string, dob: string) => `${clinicId}|${lastName(full)}|${dob}`;
export const phoneKey = (clinicId: string, phone: string) => `${clinicId}|${phoneDigits(phone)}`;
/**
 * One person: first and last name (as the identity check compares them, so middle
 * names and accents do not matter), date of birth and phone. Twins share a last
 * name, a birthday and the family phone, and differ by first name.
 */
export const identityKey = (clinicId: string, first: string, last: string, dob: string, phone: string) =>
  `${clinicId}|${firstName(first)}|${lastName(last)}|${dob}|${phoneDigits(phone)}`;

/** A phone number the identity check can use: at least 10 digits, or 7 outside North America. */
export const usablePhone = (phone: string | null | undefined, northAmerica = true) => !!phone && phone.replace(/\D/g, '').length >= (northAmerica ? 10 : 7);

type Row = typeof patients.$inferSelect;

export class PostgresPatientDirectory implements PatientDirectory {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher, private readonly actor = 'voice-agent') {}

  /**
   * Narrows by keyed hashes of last name with date of birth, and of the phone, then
   * decrypts only those few rows to compare first names. Every successful lookup is a
   * PHI access and is audited in the same transaction.
   */
  async findByIdentity(clinicId: string, fullName: string, dob: string, phone: string): Promise<PatientLookup> {
    return withClinic(this.db, clinicId, async (tx) => {
      const matches = (await this.candidates(tx, clinicId, fullName, dob))
        .filter((r) => r.phoneHash === this.cipher.hash(phoneKey(clinicId, phone)) && namesMatch(fullName, this.fullName(clinicId, r)));
      if (matches.length > 1) return { status: 'ambiguous' } as const;
      const match = matches[0];
      if (!match) return { status: 'not_found' } as const;
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.identified', entity: 'patient', entityId: match.id });
      return { status: 'found', patient: this.callPatient(clinicId, match) } as const;
    });
  }

  /**
   * A new patient, added on a call. The same person already on file (same name, date
   * of birth and phone) is not added again: the caller gave exactly what verification
   * asks for, so they are that patient. Someone else with the same name and birthday
   * but another phone is a different person and is added; `similar` tells the front
   * desk to look, without the caller ever hearing about the other record.
   */
  async register(clinicId: string, p: { firstName: string; lastName: string; dob: string; phone: string; guardianName: string | null; callId: string }): Promise<Registration> {
    return withClinic(this.db, clinicId, async (tx) => {
      const identity = this.cipher.hash(identityKey(clinicId, p.firstName, p.lastName, p.dob, p.phone));
      const [same] = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.identityHash, identity)));
      if (same) {
        await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.identified', entity: 'patient', entityId: same.id, callId: p.callId });
        return { status: 'exists', patient: this.callPatient(clinicId, same) } as const;
      }
      const full = `${p.firstName} ${p.lastName}`;
      const similar = (await this.candidates(tx, clinicId, full, p.dob)).some((r) => namesMatch(full, this.fullName(clinicId, r)));
      const [row] = await tx.insert(patients).values({
        clinicId, ...sealPatient(this.cipher, clinicId, { ...p, guardianName: p.guardianName }), status: 'new', createdByCallId: p.callId,
      }).returning();
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.created', entity: 'patient', entityId: row!.id, callId: p.callId });
      return { status: 'created', patient: this.callPatient(clinicId, row!), similar } as const;
    });
  }

  /** For seeds, imports and tests. Stores only ciphertext and keyed hashes. */
  async create(clinicId: string, p: { firstName: string; lastName: string; dob: string; phone: string; guardianName?: string | null }): Promise<string> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.insert(patients).values({ clinicId, ...sealPatient(this.cipher, clinicId, p) }).returning({ id: patients.id });
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.created', entity: 'patient', entityId: row!.id });
      return row!.id;
    });
  }

  private candidates(tx: Tx, clinicId: string, fullName: string, dob: string) {
    return tx.select().from(patients)
      .where(and(eq(patients.clinicId, clinicId), eq(patients.lookupHash, this.cipher.hash(patientLookupKey(clinicId, fullName, dob)))));
  }

  private fullName(clinicId: string, r: Row) {
    const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
    return `${this.cipher.decrypt(r.firstNameEnc, ctx('first_name'))} ${this.cipher.decrypt(r.lastNameEnc, ctx('last_name'))}`;
  }

  private callPatient(clinicId: string, r: Row): CallPatient {
    const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
    return {
      id: r.id,
      firstName: this.cipher.decrypt(r.firstNameEnc, ctx('first_name')),
      phone: r.phoneEnc ? this.cipher.decrypt(r.phoneEnc, ctx('phone')) : null,
      dob: this.cipher.decrypt(r.dobEnc, ctx('dob')),
      isNew: r.status === 'new',
    };
  }
}

/** The stored form of a patient's details: ciphertext and keyed hashes, computed one way for every path that writes a patient. */
export function sealPatient(cipher: PhiCipher, clinicId: string, p: { firstName: string; lastName: string; dob: string; phone: string; guardianName?: string | null }) {
  const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
  const phone = p.phone.trim();
  const guardian = p.guardianName?.trim() || null;
  return {
    lookupHash: cipher.hash(patientLookupKey(clinicId, `${p.firstName} ${p.lastName}`, p.dob)),
    identityHash: cipher.hash(identityKey(clinicId, p.firstName, p.lastName, p.dob, phone)),
    firstNameEnc: cipher.encrypt(p.firstName.trim(), ctx('first_name')),
    lastNameEnc: cipher.encrypt(p.lastName.trim(), ctx('last_name')),
    dobEnc: cipher.encrypt(p.dob, ctx('dob')),
    phoneEnc: cipher.encrypt(phone, ctx('phone')),
    phoneHash: cipher.hash(phoneKey(clinicId, phone)),
    guardianNameEnc: guardian ? cipher.encrypt(guardian, ctx('guardian_name')) : null,
  };
}

/**
 * Recomputes every patient's lookup and identity hashes from the stored details, after
 * the name normaliser changes or an upgrade adds a hash: until then a patient whose
 * hashes were made the old way cannot be verified. Safe to run more than once, since it
 * only rewrites hashes that differ. Owner connection, one clinic at a time, with one
 * audit row per clinic that records how many changed. Patients with no phone number
 * (added before v0.5 made it required) are counted, so the front desk can add theirs.
 */
export async function rehashPatientLookups(db: Database, cipher: PhiCipher): Promise<{ checked: number; changed: number; withoutPhone: number; duplicates: number }> {
  let checked = 0;
  let changed = 0;
  let withoutPhone = 0;
  let duplicates = 0;
  const clinicIds = (await db.execute(sql`select id from clinics order by id`)).rows as { id: string }[];
  for (const { id: clinicId } of clinicIds) {
    await withClinic(db, clinicId, async (tx) => {
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      let n = 0;
      const seen = new Set<string>();
      const rows = await tx.select({ id: patients.id, lookupHash: patients.lookupHash, identityHash: patients.identityHash, first: patients.firstNameEnc, last: patients.lastNameEnc, dob: patients.dobEnc, phone: patients.phoneEnc })
        .from(patients).where(eq(patients.clinicId, clinicId)).orderBy(patients.createdAt, patients.id);
      for (const r of rows) {
        checked++;
        const first = cipher.decrypt(r.first, ctx('first_name'));
        const last = cipher.decrypt(r.last, ctx('last_name'));
        const dob = cipher.decrypt(r.dob, ctx('dob'));
        const lookupHash = cipher.hash(patientLookupKey(clinicId, `${first} ${last}`, dob));
        let identityHash: string | null = null;
        if (r.phone) {
          identityHash = cipher.hash(identityKey(clinicId, first, last, dob, cipher.decrypt(r.phone, ctx('phone'))));
          // the same person twice, from before identities were unique: the later row keeps no identity until staff merge them
          if (seen.has(identityHash)) { duplicates++; identityHash = null; } else seen.add(identityHash);
        } else withoutPhone++;
        if (lookupHash === r.lookupHash && identityHash === r.identityHash) continue;
        await tx.update(patients).set({ lookupHash, identityHash }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, r.id)));
        n++;
      }
      changed += n;
      if (n) await tx.insert(auditLogs).values({ clinicId, actor: 'system', action: 'patient.lookups.rehashed', entity: 'clinic', entityId: clinicId, counts: { patients: n } });
    });
  }
  return { checked, changed, withoutPhone, duplicates };
}
