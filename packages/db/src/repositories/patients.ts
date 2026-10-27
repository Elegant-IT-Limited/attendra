// SPDX-License-Identifier: AGPL-3.0-only
import { type CallPatient, Gender, MAX_NEW_PATIENTS_PER_PHONE_PER_DAY, namesMatch, normalizeName, soundsLike, type PatientDirectory, type PatientLookup, phoneDigits, type Registration } from '@attendra/core';
import { and, count, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, clinics, patients } from '../schema';

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
   * A pet, by the number it is on and its name as the caller says it. Narrows by the keyed phone
   * hash (the household), then decrypts only those rows to compare the pet's name: the same name,
   * else one that sounds like it (soundsLike), so "Minnie" finds Mini. The owner's name plays no
   * part: the number is the household, and names are spelled any way. Two pets on the number that
   * sound alike go to staff. Audited like findByIdentity.
   */
  async findPet(clinicId: string, petName: string, phone: string, callId?: string): Promise<PatientLookup> {
    return withClinic(this.db, clinicId, async (tx) => {
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      const rows = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, this.cipher.hash(phoneKey(clinicId, phone))))).orderBy(patients.createdAt);
      const pet = firstName(petName);
      const named = rows.map((r) => ({ r, name: firstName(this.cipher.decrypt(r.firstNameEnc, ctx('first_name'))) }));
      const exact = named.filter((x) => x.name === pet);
      const matches = (exact.length ? exact : named.filter((x) => soundsLike(pet, x.name))).map((x) => x.r);
      if (matches.length > 1) return { status: 'ambiguous' } as const;
      const match = matches[0];
      if (!match) return { status: 'not_found' } as const;
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.identified.by_number', entity: 'patient', entityId: match.id, callId: callId ?? null });
      return { status: 'found', patient: this.callPatient(clinicId, match) } as const;
    });
  }

  /**
   * The one first name on file for this number (the owner for a pet, else the patient),
   * so the assistant can ask "Am I speaking with Sam?" as a front desk does when caller
   * ID shows a client. Only when there is exactly one: two families on one phone give
   * nothing. A first name only, never a pet or a record; reading it is audited.
   */
  async nameOnFile(clinicId: string, phone: string, callId: string): Promise<string | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const owner = await this.owner(tx, clinicId, phone);
      if (!owner) return null;
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.name_on_file.read', entity: 'call', entityId: callId, callId });
      return owner;
    });
  }

  /**
   * The owner of a number: the first name on the first record registered with it (its guardian, or
   * the patient at a clinic for people). One number is one household with one owner, so a name said
   * on a later call never changes it.
   */
  private async owner(tx: Tx, clinicId: string, phone: string): Promise<string | null> {
    const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
    const [first] = await tx.select({ first: patients.firstNameEnc, guardian: patients.guardianNameEnc }).from(patients)
      .where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, this.cipher.hash(phoneKey(clinicId, phone))))).orderBy(patients.createdAt).limit(1);
    if (!first) return null;
    const name = (first.guardian ? this.cipher.decrypt(first.guardian, ctx('guardian_name')) : this.cipher.decrypt(first.first, ctx('first_name'))).trim().split(/\s+/)[0] ?? '';
    return name || null;
  }

  /** The number's owner, as written on its first record, and the first names of its pets in the order they were registered, for the dashboard's pet form. Audited by how many were read, never by the number. */
  async household(clinicId: string, phone: string): Promise<{ owner: string | null; pets: string[] }> {
    return withClinic(this.db, clinicId, async (tx) => {
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      const owner = await this.ownerOnFile(tx, clinicId, phone);
      const rows = await tx.select({ first: patients.firstNameEnc }).from(patients)
        .where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, this.cipher.hash(phoneKey(clinicId, phone))))).orderBy(patients.createdAt).limit(20);
      if (rows.length) await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.household.read', entity: 'household', entityId: String(rows.length) });
      return { owner, pets: rows.map((r) => this.cipher.decrypt(r.first, ctx('first_name')).trim().split(/\s+/)[0] ?? '').filter(Boolean) };
    });
  }

  /**
   * The first names of the pets on this number, the household, so a caller the number knows can pick
   * one ("Is this for Biscuit or Max?"). At most three, with `more` for the rest; a first name only,
   * never a record. Reading them is audited; finding none is not.
   */
  async petsOnNumber(clinicId: string, phone: string, callId: string): Promise<{ names: string[]; more: boolean }> {
    return withClinic(this.db, clinicId, async (tx) => {
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      const rows = await tx.select({ first: patients.firstNameEnc }).from(patients)
        .where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, this.cipher.hash(phoneKey(clinicId, phone))))).orderBy(patients.createdAt).limit(20);
      const names = new Map<string, string>();
      for (const r of rows) {
        const n = this.cipher.decrypt(r.first, ctx('first_name')).trim().split(/\s+/)[0] ?? '';
        if (n && !names.has(n.toLowerCase())) names.set(n.toLowerCase(), n);
      }
      if (!names.size) return { names: [], more: false };
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.pets_on_number.read', entity: 'call', entityId: callId, callId });
      const all = [...names.values()];
      return { names: all.slice(0, 3), more: all.length > 3 };
    });
  }

  /**
   * A new patient, added on a call. The same person already on file (same name, date
   * of birth and phone) is not added again: the caller gave exactly what verification
   * asks for, so they are that patient. Someone else with the same name and birthday
   * but another phone is a different person and is added; `similar` tells the front
   * desk to look, without the caller ever hearing about the other record. One phone
   * number adds at most MAX_NEW_PATIENTS_PER_PHONE_PER_DAY new patients in 24 hours.
   */
  async register(clinicId: string, p: { firstName: string; lastName: string; dob: string; gender: Gender; phone: string; guardianName: string | null; callId: string; species?: string | null }): Promise<Registration> {
    const attempt = () => withClinic(this.db, clinicId, async (tx) => {
      const sameId = await findSameIdentity(tx, this.cipher, clinicId, p);
      if (sameId) {
        const [same] = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, sameId)));
        await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.identified', entity: 'patient', entityId: same!.id, callId: p.callId });
        return { status: 'exists', patient: this.callPatient(clinicId, same!) } as const;
      }
      // added on calls from this number in the last 24 hours, whoever they were
      const [added] = await tx.select({ n: count() }).from(patients).where(and(eq(patients.clinicId, clinicId),
        eq(patients.phoneHash, this.cipher.hash(phoneKey(clinicId, p.phone))), isNotNull(patients.createdByCallId),
        gt(patients.createdAt, sql`now() - interval '24 hours'`)));
      if ((added?.n ?? 0) >= MAX_NEW_PATIENTS_PER_PHONE_PER_DAY) return { status: 'limited' } as const;
      const full = `${p.firstName} ${p.lastName}`;
      const similar = (await this.candidates(tx, clinicId, full, p.dob)).some((r) => namesMatch(full, this.fullName(clinicId, r)));
      // one number, one owner: a pet added under a number that has one joins that owner, whatever name was said now
      const owner = p.guardianName !== null ? await this.ownerOnFile(tx, clinicId, p.phone) : null;
      const [row] = await tx.insert(patients).values({
        clinicId, ...sealPatient(this.cipher, clinicId, { ...p, guardianName: owner ?? p.guardianName }), status: 'new', createdByCallId: p.callId,
      }).returning();
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.created', entity: 'patient', entityId: row!.id, callId: p.callId });
      return { status: 'created', patient: this.callPatient(clinicId, row!), similar } as const;
    });
    // two requests adding the same person at once: the second finds the first
    return attempt().catch((err: unknown) => { if (isSameIdentity(err)) return attempt(); throw err; });
  }

  /** For seeds, imports and tests. Stores only ciphertext and keyed hashes. */
  async create(clinicId: string, p: { firstName: string; lastName: string; dob: string; phone: string; guardianName?: string | null; gender?: Gender | null; species?: string | null }): Promise<string> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.insert(patients).values({ clinicId, ...sealPatient(this.cipher, clinicId, p) }).returning({ id: patients.id });
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.created', entity: 'patient', entityId: row!.id });
      return row!.id;
    });
  }

  /** The guardian name on the first record registered with the number, as written there, or null when the number is new. */
  private async ownerOnFile(tx: Tx, clinicId: string, phone: string): Promise<string | null> {
    const [first] = await tx.select({ guardian: patients.guardianNameEnc }).from(patients)
      .where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, this.cipher.hash(phoneKey(clinicId, phone))))).orderBy(patients.createdAt).limit(1);
    const name = first?.guardian ? this.cipher.decrypt(first.guardian, phiContext(clinicId, 'patients.guardian_name')).trim() : '';
    return name || null;
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
      species: r.speciesEnc ? this.cipher.decrypt(r.speciesEnc, ctx('species')) : null,
      guardianName: r.guardianNameEnc ? this.cipher.decrypt(r.guardianNameEnc, ctx('guardian_name')) : null,
      textsOk: !!r.smsConsentAt,
    };
  }

  /** They said yes to reminder texts on a call: kept on the record, audited with the call. */
  async setTextConsent(clinicId: string, patientId: string, callId: string): Promise<void> {
    await withClinic(this.db, clinicId, async (tx) => {
      const done = await tx.update(patients).set({ smsConsentAt: new Date(), smsConsentSource: 'call' })
        .where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId))).returning({ id: patients.id });
      if (done.length) await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.texts_ok.call', entity: 'patient', entityId: patientId, callId });
    });
  }
}

/** The stored form of a patient's details: ciphertext and keyed hashes, computed one way for every path that writes a patient. */
/** A stored gender, or null for a patient from before it was recorded (or a value no longer offered). */
export function readGenderColumn(cipher: PhiCipher, clinicId: string, enc: string | null): Gender | null {
  if (!enc) return null;
  const parsed = Gender.safeParse(cipher.decrypt(enc, phiContext(clinicId, 'patients.gender')));
  return parsed.success ? parsed.data : null;
}

export function sealPatient(cipher: PhiCipher, clinicId: string, p: { firstName: string; lastName: string; dob: string; phone: string; guardianName?: string | null; gender?: Gender | null; species?: string | null }) {
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
    ...(p.species !== undefined ? { speciesEnc: p.species?.trim() ? cipher.encrypt(p.species.trim().toLowerCase(), ctx('species')) : null } : {}),
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

/**
 * One number, one owner: every pet on a number is put under the owner of its first-registered record, the name as
 * written there (the rule from 2026-11; records made before it could carry a second owner's name on a family number).
 * Counts only, never a name: how many numbers had more than one owner name, and how many pets were moved. With
 * `apply` false nothing is written. Safe to run more than once.
 */
export async function unifyHouseholds(db: Database, cipher: PhiCipher, opts: { apply: boolean }): Promise<{ clinics: number; numbers: number; pets: number }> {
  const ids = (await db.select({ id: clinics.id }).from(clinics)).map((c) => c.id);
  let numbers = 0;
  let pets = 0;
  for (const clinicId of ids) {
    const ctx = phiContext(clinicId, 'patients.guardian_name');
    const moved = await withClinic(db, clinicId, async (tx) => {
      const rows = await tx.select({ id: patients.id, phoneHash: patients.phoneHash, guardian: patients.guardianNameEnc, createdAt: patients.createdAt }).from(patients)
        .where(and(eq(patients.clinicId, clinicId), isNotNull(patients.phoneHash), isNotNull(patients.guardianNameEnc))).orderBy(patients.createdAt);
      const byNumber = new Map<string, typeof rows>();
      for (const r of rows) byNumber.set(r.phoneHash!, [...(byNumber.get(r.phoneHash!) ?? []), r]);
      let touched = 0;
      let changed = 0;
      for (const group of byNumber.values()) {
        const owner = cipher.decrypt(group[0]!.guardian!, ctx);
        const others = group.slice(1).filter((r) => normalizeName(cipher.decrypt(r.guardian!, ctx)) !== normalizeName(owner));
        if (!others.length) continue;
        touched++;
        changed += others.length;
        if (!opts.apply) continue;
        for (const r of others) {
          await tx.update(patients).set({ guardianNameEnc: cipher.encrypt(owner, ctx) }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, r.id)));
          await tx.insert(auditLogs).values({ clinicId, actor: 'system', action: 'patient.owner.unified', entity: 'patient', entityId: r.id });
        }
      }
      return { touched, changed };
    });
    numbers += moved.touched;
    pets += moved.changed;
  }
  return { clinics: ids.length, numbers, pets };
}
