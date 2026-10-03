// SPDX-License-Identifier: AGPL-3.0-only
import { type CallPatient, Gender, namesMatch, normalizeName, type PatientDirectory, type PatientLookup, phoneDigits, type Registration } from '@attendra/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, patients } from '../schema';

const lastName = (full: string) => normalizeName(full).split(' ').at(-1) ?? '';
const firstName = (full: string) => normalizeName(full).split(' ')[0] ?? '';
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

/** Whether an insert failed only because the same person is already stored: another request added them a moment ago. */
export const isSameIdentity = (err: unknown) => {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const c = e.cause ?? e;
  return c.code === '23505' && (c.constraint === 'patients_identity' || !c.constraint);
};

/**
 * The same person already on file: by identity hash, or, for a row written before
 * v0.5 that has none yet, by last name and date of birth, phone and first name.
 */
export async function findSameIdentity(tx: Tx, cipher: PhiCipher, clinicId: string, p: { firstName: string; lastName: string; dob: string; phone: string }, except?: string): Promise<string | null> {
  const [hit] = (await tx.select({ id: patients.id }).from(patients)
    .where(and(eq(patients.clinicId, clinicId), eq(patients.identityHash, cipher.hash(identityKey(clinicId, p.firstName, p.lastName, p.dob, p.phone))))))
    .filter((r) => r.id !== except);
  if (hit) return hit.id;
  const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
  const older = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), isNull(patients.identityHash),
    eq(patients.lookupHash, cipher.hash(patientLookupKey(clinicId, `${p.firstName} ${p.lastName}`, p.dob))), eq(patients.phoneHash, cipher.hash(phoneKey(clinicId, p.phone)))));
  return older.find((r) => r.id !== except && namesMatch(`${p.firstName} ${p.lastName}`, `${cipher.decrypt(r.firstNameEnc, ctx('first_name'))} ${cipher.decrypt(r.lastNameEnc, ctx('last_name'))}`))?.id ?? null;
}

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
  async register(clinicId: string, p: { firstName: string; lastName: string; dob: string; gender: Gender; phone: string; guardianName: string | null; callId: string }): Promise<Registration> {
    const attempt = () => withClinic(this.db, clinicId, async (tx) => {
      const sameId = await findSameIdentity(tx, this.cipher, clinicId, p);
      if (sameId) {
        const [same] = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, sameId)));
        await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.identified', entity: 'patient', entityId: same!.id, callId: p.callId });
        return { status: 'exists', patient: this.callPatient(clinicId, same!) } as const;
      }
      const full = `${p.firstName} ${p.lastName}`;
      const similar = (await this.candidates(tx, clinicId, full, p.dob)).some((r) => namesMatch(full, this.fullName(clinicId, r)));
      const [row] = await tx.insert(patients).values({
        clinicId, ...sealPatient(this.cipher, clinicId, { ...p, guardianName: p.guardianName }), status: 'new', createdByCallId: p.callId,
      }).returning();
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.created', entity: 'patient', entityId: row!.id, callId: p.callId });
      return { status: 'created', patient: this.callPatient(clinicId, row!), similar } as const;
    });
    // two requests adding the same person at once: the second finds the first
    return attempt().catch((err: unknown) => { if (isSameIdentity(err)) return attempt(); throw err; });
  }

  /** For seeds, imports and tests. Stores only ciphertext and keyed hashes. */
  async create(clinicId: string, p: { firstName: string; lastName: string; dob: string; phone: string; guardianName?: string | null; gender?: Gender | null }): Promise<string> {
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
      gender: readGenderColumn(this.cipher, clinicId, r.genderEnc),
    };
  }
}

/** The stored form of a patient's details: ciphertext and keyed hashes, computed one way for every path that writes a patient. */
/** A stored gender, or null for a patient from before it was recorded (or a value no longer offered). */
export function readGenderColumn(cipher: PhiCipher, clinicId: string, enc: string | null): Gender | null {
  if (!enc) return null;
  const parsed = Gender.safeParse(cipher.decrypt(enc, phiContext(clinicId, 'patients.gender')));
  return parsed.success ? parsed.data : null;
}

export function sealPatient(cipher: PhiCipher, clinicId: string, p: { firstName: string; lastName: string; dob: string; phone: string; guardianName?: string | null; gender?: Gender | null }) {
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
    // left as it is when not given, so an edit that does not touch it keeps it
    ...(p.gender !== undefined ? { genderEnc: p.gender ? cipher.encrypt(p.gender, ctx('gender')) : null } : {}),
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
      const rows = await tx.select({ id: patients.id, lookupHash: patients.lookupHash, identityHash: patients.identityHash, phoneHash: patients.phoneHash, first: patients.firstNameEnc, last: patients.lastNameEnc, dob: patients.dobEnc, phone: patients.phoneEnc })
        .from(patients).where(eq(patients.clinicId, clinicId)).orderBy(patients.createdAt, patients.id);
      // identities already stored, by whom: a patient added since the upgrade may already hold the one an older row would get
      const holder = new Map(rows.filter((r) => r.identityHash).map((r) => [r.identityHash!, r.id]));
      for (const r of rows) {
        checked++;
        // without a phone a patient cannot be verified, and migration 0020 lets no such row change until one is added
        if (!r.phone) { withoutPhone++; continue; }
        const first = cipher.decrypt(r.first, ctx('first_name'));
        const last = cipher.decrypt(r.last, ctx('last_name'));
        const dob = cipher.decrypt(r.dob, ctx('dob'));
        const phone = cipher.decrypt(r.phone, ctx('phone'));
        const lookupHash = cipher.hash(patientLookupKey(clinicId, `${first} ${last}`, dob));
        const phoneHash = cipher.hash(phoneKey(clinicId, phone));
        let identityHash: string | null = cipher.hash(identityKey(clinicId, first, last, dob, phone));
        // the same person twice, from before identities were unique: the later row keeps no identity until staff merge them
        const owner = holder.get(identityHash);
        if (owner && owner !== r.id) { duplicates++; identityHash = null; } else holder.set(identityHash, r.id);
        if (lookupHash === r.lookupHash && phoneHash === r.phoneHash && identityHash === r.identityHash) continue;
        if (r.identityHash && r.identityHash !== identityHash && holder.get(r.identityHash) === r.id) holder.delete(r.identityHash);
        await tx.update(patients).set({ lookupHash, phoneHash, identityHash }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, r.id)));
        n++;
      }
      changed += n;
      if (n) await tx.insert(auditLogs).values({ clinicId, actor: 'system', action: 'patient.lookups.rehashed', entity: 'clinic', entityId: clinicId, counts: { patients: n } });
    });
  }
  return { checked, changed, withoutPhone, duplicates };
}
