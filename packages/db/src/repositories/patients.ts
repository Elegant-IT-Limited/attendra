// SPDX-License-Identifier: AGPL-3.0-only
import { type CallPatient, fold, Gender, MAX_NEW_PATIENTS_PER_PHONE_PER_DAY, namesMatch, normalizeName, soundsLike, spokenKey, type PatientDirectory, type PatientLookup, phoneDigits, type Registration } from '@attendra/core';
import { and, count, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, clinics, patients, patientSearchKeys } from '../schema';

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

/** The search lookups of migration 0042: one word of a name, or the last four digits of a phone, keyed per clinic like the others. */
export const ownerWordKey = (clinicId: string, word: string) => `${clinicId}|word|${word}`;
export const PHONE_SUFFIX_DIGITS = 4;
export const phoneSuffixKey = (clinicId: string, phone: string) => `${clinicId}|suffix|${phone.replace(/\D/g, '').slice(-PHONE_SUFFIX_DIGITS)}`;

/**
 * The search keys of migration 0049, one row each in patient_search_keys, each kind in its own form so that one can
 * never equal another: "ma" as the start of a word is not "ma" the whole word.
 *   word    every whole word of the record's own and its owner's name
 *   prefix  the first one, two and three letters of each of those words, so one to three typed letters find their
 *           records by the keys alone, and a longer word its candidates
 *   sounds  the first three letters of each word's spoken key (soundsLike), so "Danial" still finds Daniel
 *   dob     the whole date of birth
 *   digits  the start of the phone (as written, without its country code, or dialled at home with a 0), and every run
 *           of three to nine digits inside it; ten or more typed digits are a whole number (phone_hash)
 * A key only says where to look: every candidate is still matched on its decrypted details, so two keys that happen
 * to share their shortened hash cost one more record read, never a wrong result.
 */
export const NAME_PREFIX_LETTERS = 3;
export const SOUND_LETTERS = 3;
export const PHONE_PART_DIGITS = 9;
/** Shorter runs than this are keyed only at the start of a number: one or two digits are inside nearly every number. */
export const PHONE_RUN_DIGITS = 3;
/** How much of the keyed hash a search key keeps: 72 bits, plenty to tell a clinic's keys apart, and a smaller index. */
export const SEARCH_HASH_CHARS = 12;
export const namePrefixKey = (clinicId: string, prefix: string) => `${clinicId}|prefix|${prefix}`;
export const soundsKey = (clinicId: string, sound: string) => `${clinicId}|sounds|${sound}`;
export const dobKey = (clinicId: string, dob: string) => `${clinicId}|dob|${dob}`;
export const phonePartKey = (clinicId: string, digits: string) => `${clinicId}|digits|${digits}`;
/** The stored and searched form of one search key. */
export const searchHash = (cipher: PhiCipher, key: string) => cipher.hash(key).slice(0, SEARCH_HASH_CHARS);

/**
 * The patients holding at least one of these keys, as a subquery for `inArray(…, patientsWithKey(…))`. An equality
 * lookup on purpose: under Row Level Security only a leakproof operator can use an index, and text equality is one.
 */
export const patientsWithKey = (tx: Tx, cipher: PhiCipher, clinicId: string, keys: string[]) =>
  tx.select({ id: patientSearchKeys.patientId }).from(patientSearchKeys)
    .where(and(eq(patientSearchKeys.clinicId, clinicId), inArray(patientSearchKeys.key, keys.map((k) => searchHash(cipher, k)))));

/** The sound key a word is stored and searched under: the start of its spoken key, empty for a word with no letters. */
export const soundOf = (word: string) => spokenKey(word).slice(0, SOUND_LETTERS);

/** The digit runs a phone number is found by: its start in each form it is typed in, and every run of three to nine digits inside it. */
export function phoneParts(phone: string | null): string[] {
  const all = phone?.replace(/\D/g, '') ?? '';
  if (!all) return [];
  const parts = new Set<string>();
  for (const form of [all, all.slice(-10), `0${all.slice(-10)}`]) {
    for (let n = 1; n <= Math.min(PHONE_PART_DIGITS, form.length); n++) parts.add(form.slice(0, n));
  }
  for (let start = 0; start < all.length; start++) {
    for (let n = PHONE_RUN_DIGITS; n <= PHONE_PART_DIGITS && start + n <= all.length; n++) parts.add(all.slice(start, start + n));
  }
  return [...parts];
}

/** The keys a typed name word is looked up by: its first letters (up to three), and its sound when it has one. */
export function nameWordKeys(clinicId: string, word: string): string[] {
  const sound = soundOf(word);
  return [namePrefixKey(clinicId, word.slice(0, NAME_PREFIX_LETTERS)), ...(sound ? [soundsKey(clinicId, sound)] : [])];
}

/** The words a record can be searched by: the owner's (guardian's) name and the patient's own, folded and lower-cased, each once. */
export const searchWords = (p: { firstName: string; lastName: string; guardianName?: string | null }) =>
  [...new Set([p.guardianName ?? '', p.firstName, p.lastName].flatMap((s) => normalizeName(s).split(' ')).filter(Boolean))];

/**
 * Where typed digits sit in a phone number: 0 when the number starts with them (as
 * written with or without its country code, or with a leading 0 the way many
 * countries dial at home), 1 when they are somewhere inside it, null when not at all.
 * Shared by the Pets and the Calls search.
 */
export function phoneMatch(typed: string, phone: string | null): 0 | 1 | null {
  if (!phone) return null;
  const all = phone.replace(/\D/g, '');
  const national = all.slice(-10);
  const forms = [all, national, `0${national}`];
  if (forms.some((f) => f.startsWith(typed))) return 0;
  return forms.some((f) => f.includes(typed)) ? 1 : null;
}

/** The hashed form of the 0042 lookups, in a fixed order so two computations of the same record compare equal. */
export function searchLookups(cipher: PhiCipher, clinicId: string, p: { firstName: string; lastName: string; guardianName?: string | null; phone: string | null }) {
  const digits = p.phone?.replace(/\D/g, '') ?? '';
  return {
    ownerWordsHash: searchWords(p).map((w) => cipher.hash(ownerWordKey(clinicId, w))).sort(),
    phoneSuffixHash: digits.length >= PHONE_SUFFIX_DIGITS ? cipher.hash(phoneSuffixKey(clinicId, digits)) : null,
  };
}

type Searchable = { firstName: string; lastName: string; guardianName?: string | null; phone: string | null; dob: string };

/** Every search key of a record (migration 0049), hashed, each once and sorted, so two computations compare equal. */
export function searchKeyHashes(cipher: PhiCipher, clinicId: string, p: Searchable): string[] {
  const keys = new Set<string>();
  for (const w of searchWords(p)) {
    keys.add(ownerWordKey(clinicId, w));
    for (let n = 1; n <= Math.min(NAME_PREFIX_LETTERS, w.length); n++) keys.add(namePrefixKey(clinicId, w.slice(0, n)));
    const sound = soundOf(w);
    if (sound) keys.add(soundsKey(clinicId, sound));
  }
  keys.add(dobKey(clinicId, p.dob));
  for (const part of phoneParts(p.phone)) keys.add(phonePartKey(clinicId, part));
  return [...new Set([...keys].map((k) => searchHash(cipher, k)))].sort();
}

/** Replaces a patient's search keys, in the transaction that wrote the patient. */
export async function writeSearchKeys(tx: Tx, cipher: PhiCipher, clinicId: string, patientId: string, p: Searchable) {
  await tx.delete(patientSearchKeys).where(and(eq(patientSearchKeys.clinicId, clinicId), eq(patientSearchKeys.patientId, patientId)));
  await tx.insert(patientSearchKeys).values(searchKeyHashes(cipher, clinicId, p).map((key) => ({ clinicId, key, patientId })));
}

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
   * A pet by the last four digits of its number and its name, for a caller whose number could not be found
   * (2026-11-15). Narrows by the keyed hash of the last four digits (migration 0042, never a scan of every record),
   * then decrypts only those rows' first names to compare the pet's, as findPet does. Found only when exactly one pet
   * in exactly one household (one number) matches: two households sharing the last four digits with a pet of that name
   * are 'ambiguous', and the caller goes to the team. Audited like findPet.
   */
  async findPetByLastFour(clinicId: string, lastFour: string, petName: string, callId: string): Promise<PatientLookup> {
    const digits = lastFour.replace(/\D/g, '');
    if (digits.length !== PHONE_SUFFIX_DIGITS) return { status: 'not_found' };
    return withClinic(this.db, clinicId, async (tx) => {
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      const rows = await tx.select().from(patients)
        .where(and(eq(patients.clinicId, clinicId), eq(patients.phoneSuffixHash, this.cipher.hash(phoneSuffixKey(clinicId, digits))))).orderBy(patients.createdAt).limit(200);
      const pet = firstName(petName);
      const named = rows.map((r) => ({ r, name: firstName(this.cipher.decrypt(r.firstNameEnc, ctx('first_name'))) }));
      const exact = named.filter((x) => x.name === pet);
      const matches = (exact.length ? exact : named.filter((x) => soundsLike(pet, x.name))).map((x) => x.r);
      if (!matches.length) return { status: 'not_found' } as const;
      const households = new Set(matches.map((r) => r.phoneHash ?? r.id));
      if (matches.length > 1 || households.size > 1) return { status: 'ambiguous' } as const;
      const match = matches[0]!;
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.identified.by_last_four', entity: 'patient', entityId: match.id, callId });
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
   * The household on a number for a caller who is known (caller ID, or a name that matched): the owner's first name on
   * file and the pets' first names, at most three with `more` for the rest. Audited as a read of the household on the
   * call; finding nothing is not.
   */
  async householdOnNumber(clinicId: string, phone: string, callId: string): Promise<{ owner: string | null; names: string[]; more: boolean }> {
    return withClinic(this.db, clinicId, async (tx) => {
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      const rows = await tx.select({ first: patients.firstNameEnc }).from(patients)
        .where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, this.cipher.hash(phoneKey(clinicId, phone))))).orderBy(patients.createdAt).limit(20);
      const names = new Map<string, string>();
      for (const r of rows) {
        const n = this.cipher.decrypt(r.first, ctx('first_name')).trim().split(/\s+/)[0] ?? '';
        if (n && !names.has(n.toLowerCase())) names.set(n.toLowerCase(), n);
      }
      if (!names.size) return { owner: null, names: [], more: false };
      const owner = (await this.ownerOnFile(tx, clinicId, phone))?.split(/\s+/)[0] ?? null;
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: 'patient.household.read.call', entity: 'call', entityId: callId, callId });
      const all = [...names.values()];
      return { owner, names: all.slice(0, 3), more: all.length > 3 };
    });
  }

  /**
   * Whether the name a caller gave on a number they said is the owner's on file: the first words compared by sound and
   * with the same first two letters, accents and case aside ("Jordon" is Jordan). The name on file never leaves this
   * method: only the result does, and only the result is audited. 'name_needed' when the number has an owner and no name
   * was given; 'no_owner' when the number has no owner on file (a new household).
   */
  async ownerMatches(clinicId: string, phone: string, saidName: string | null, callId: string): Promise<'match' | 'no_match' | 'no_owner' | 'name_needed'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const owner = await this.ownerOnFile(tx, clinicId, phone);
      if (!owner) return 'no_owner' as const;
      if (!saidName?.trim()) return 'name_needed' as const;
      const result = sameOwnerName(saidName, owner) ? 'match' as const : 'no_match' as const;
      await tx.insert(auditLogs).values({ clinicId, actor: this.actor, action: `patient.owner_check.${result}`, entity: 'call', entityId: callId, callId });
      return result;
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
      await writeSearchKeys(tx, this.cipher, clinicId, row!.id, { ...p, guardianName: owner ?? p.guardianName });
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
      await writeSearchKeys(tx, this.cipher, clinicId, row!.id, p);
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
    // so a search finds the record by its owner's name or the phone's last digits past the rows it can decrypt
    ...searchLookups(cipher, clinicId, { firstName: p.firstName, lastName: p.lastName, guardianName: guardian, phone }),
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
 * With `apply` false nothing is written: the counts say what a run with it would change.
 */
export async function rehashPatientLookups(db: Database, cipher: PhiCipher, opts: { apply: boolean }): Promise<{ checked: number; changed: number; withoutPhone: number; duplicates: number; searchable: number }> {
  let checked = 0;
  let changed = 0;
  let withoutPhone = 0;
  let duplicates = 0;
  let searchable = 0;
  const sameWords = (a: string[] | null, b: string[]) => !!a && a.length === b.length && a.every((w, i) => w === b[i]);
  const clinicIds = (await db.execute(sql`select id from clinics order by id`)).rows as { id: string }[];
  for (const { id: clinicId } of clinicIds) {
    await withClinic(db, clinicId, async (tx) => {
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      let n = 0;
      const rows = await tx.select({
        id: patients.id, lookupHash: patients.lookupHash, identityHash: patients.identityHash, phoneHash: patients.phoneHash, first: patients.firstNameEnc, last: patients.lastNameEnc, dob: patients.dobEnc, phone: patients.phoneEnc,
        guardian: patients.guardianNameEnc, ownerWordsHash: patients.ownerWordsHash, phoneSuffixHash: patients.phoneSuffixHash,
      }).from(patients).where(eq(patients.clinicId, clinicId)).orderBy(patients.createdAt, patients.id);
      // identities already stored, by whom: a patient added since the upgrade may already hold the one an older row would get
      const holder = new Map(rows.filter((r) => r.identityHash).map((r) => [r.identityHash!, r.id]));
      for (let at = 0; at < rows.length; at += 1000) {
        const batch = rows.slice(at, at + 1000);
        // the search keys of migration 0049 these patients have now, sorted the way searchKeyHashes sorts them
        const stored = new Map<string, string[]>();
        for (const k of await tx.select({ id: patientSearchKeys.patientId, key: patientSearchKeys.key }).from(patientSearchKeys)
          .where(and(eq(patientSearchKeys.clinicId, clinicId), inArray(patientSearchKeys.patientId, batch.map((r) => r.id))))) {
          stored.set(k.id, [...(stored.get(k.id) ?? []), k.key]);
        }
        for (const r of batch) {
          checked++;
          const first = cipher.decrypt(r.first, ctx('first_name'));
          const last = cipher.decrypt(r.last, ctx('last_name'));
          const dob = cipher.decrypt(r.dob, ctx('dob'));
          const phone = r.phone ? cipher.decrypt(r.phone, ctx('phone')) : null;
          const guardianName = r.guardian ? cipher.decrypt(r.guardian, ctx('guardian_name')) : null;
          // the search keys live in their own table, so even a patient with no phone gets them
          const keys = searchKeyHashes(cipher, clinicId, { firstName: first, lastName: last, guardianName, phone, dob });
          const keysChanged = !sameWords((stored.get(r.id) ?? null)?.sort() ?? null, keys);
          let rowChanged = false;
          let lookupsChanged = false;
          // without a phone a patient cannot be verified, and migration 0020 lets no such row change until one is added
          if (!phone) withoutPhone++;
          else {
            const lookupHash = cipher.hash(patientLookupKey(clinicId, `${first} ${last}`, dob));
            const phoneHash = cipher.hash(phoneKey(clinicId, phone));
            let identityHash: string | null = cipher.hash(identityKey(clinicId, first, last, dob, phone));
            // the same person twice, from before identities were unique: the later row keeps no identity until staff merge them
            const owner = holder.get(identityHash);
            if (owner && owner !== r.id) { duplicates++; identityHash = null; } else holder.set(identityHash, r.id);
            // the lookups of migration 0042, empty on every row from before it
            const search = searchLookups(cipher, clinicId, { firstName: first, lastName: last, guardianName, phone });
            lookupsChanged = !sameWords(r.ownerWordsHash, search.ownerWordsHash) || search.phoneSuffixHash !== r.phoneSuffixHash;
            rowChanged = lookupHash !== r.lookupHash || phoneHash !== r.phoneHash || identityHash !== r.identityHash || lookupsChanged;
            if (rowChanged) {
              if (r.identityHash && r.identityHash !== identityHash && holder.get(r.identityHash) === r.id) holder.delete(r.identityHash);
              if (opts.apply) await tx.update(patients).set({ lookupHash, phoneHash, identityHash, ...search }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, r.id)));
            }
          }
          if (keysChanged && opts.apply) await writeSearchKeys(tx, cipher, clinicId, r.id, { firstName: first, lastName: last, guardianName, phone, dob });
          if (rowChanged || keysChanged) n++;
          if (lookupsChanged || keysChanged) searchable++;
        }
      }
      changed += n;
      if (n && opts.apply) await tx.insert(auditLogs).values({ clinicId, actor: 'system', action: 'patient.lookups.rehashed', entity: 'clinic', entityId: clinicId, counts: { patients: n } });
    });
  }
  return { checked, changed, withoutPhone, duplicates, searchable };
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

/** The first word of a name a caller said against the owner's on file: by sound, and the same first two letters ("Al" is not "Ali" by sound alone). */
export function sameOwnerName(said: string, onFile: string): boolean {
  const first = (n: string) => fold(n).toLowerCase().replace(/[^\p{L}\s'-]/gu, '').trim().split(/\s+/)[0] ?? '';
  const [a, b] = [first(said), first(onFile)];
  if (!a || !b) return false;
  return a === b || (a.slice(0, 2) === b.slice(0, 2) && soundsLike(a, b));
}

/** One group of records on a shared number, as the dry run reports it: counts and dates only, never a name, a number or a hash. */
export interface SharedNumberGroup {
  clinicId: string;
  industry: string;
  /** `number`: the same stored phone lookup; `last 9`: the same last nine digits stored under more than one lookup (two spellings of one number). */
  groupedBy: 'number' | 'last 9';
  pets: number;
  /** Distinct owner names on the group, compared the way names are compared everywhere (case, accents and spacing do not count). */
  owners: number;
  /** Records in the group with no owner name. */
  withoutOwner: number;
  /** The records' creation dates, YYYY-MM-DD in UTC, each once, oldest first. */
  created: string[];
}

/**
 * The shared-number check (2026-11), read-only: per clinic, the records whose number is shared by more than one
 * owner name, or (at a veterinary clinic) carries an owner on some records and none on others, grouped by the stored
 * phone lookup; and the numbers whose last nine digits sit under more than one stored lookup (a number stored in two
 * spellings, from before the lookups were rebuilt), which a number said on a call can miss. Decrypts in memory only;
 * returns counts and dates. Writes nothing, not even an audit row. The owner of the install decides what to do with it.
 */
export async function sharedNumbers(db: Database, cipher: PhiCipher): Promise<{ clinics: number; groups: SharedNumberGroup[] }> {
  const all = await db.select({ id: clinics.id, config: clinics.config }).from(clinics).orderBy(clinics.id);
  const groups: SharedNumberGroup[] = [];
  for (const clinic of all) {
    const industry = String((clinic.config as { industry?: unknown } | null)?.industry ?? 'clinic');
    const clinicId = clinic.id;
    const rows = await withClinic(db, clinicId, (tx) => tx.select({ phoneHash: patients.phoneHash, phone: patients.phoneEnc, guardian: patients.guardianNameEnc, createdAt: patients.createdAt })
      .from(patients).where(and(eq(patients.clinicId, clinicId), isNotNull(patients.phoneEnc))).orderBy(patients.createdAt));
    const guardianCtx = phiContext(clinicId, 'patients.guardian_name');
    const phoneCtx = phiContext(clinicId, 'patients.phone');
    const records = rows.map((r) => ({
      stored: r.phoneHash,
      last9: cipher.hash(phoneKey(clinicId, cipher.decrypt(r.phone!, phoneCtx))),
      owner: r.guardian ? normalizeName(cipher.decrypt(r.guardian, guardianCtx)) || null : null,
      created: r.createdAt.toISOString().slice(0, 10),
    }));
    const summary = (groupedBy: SharedNumberGroup['groupedBy'], g: typeof records): SharedNumberGroup => ({
      clinicId, industry, groupedBy, pets: g.length,
      owners: new Set(g.flatMap((r) => (r.owner ? [r.owner] : []))).size,
      withoutOwner: g.filter((r) => !r.owner).length,
      created: [...new Set(g.map((r) => r.created))].sort(),
    });
    const byStored = new Map<string, typeof records>();
    const byLast9 = new Map<string, typeof records>();
    for (const r of records) {
      if (r.stored) byStored.set(r.stored, [...(byStored.get(r.stored) ?? []), r]);
      byLast9.set(r.last9, [...(byLast9.get(r.last9) ?? []), r]);
    }
    for (const g of byStored.values()) {
      if (g.length < 2) continue;
      const s = summary('number', g);
      if (s.owners > 1 || (industry === 'vet' && s.owners > 0 && s.withoutOwner > 0)) groups.push(s);
    }
    for (const g of byLast9.values()) {
      if (g.length > 1 && new Set(g.map((r) => r.stored)).size > 1) groups.push(summary('last 9', g));
    }
  }
  return { clinics: all.length, groups };
}

/** The dry run's printout: one line a group, then the totals. No names, no numbers, no hashes. */
export function formatSharedNumbers(r: { clinics: number; groups: SharedNumberGroup[] }): string[] {
  const lines = r.groups.map((g) => [`clinic ${g.clinicId}`, g.industry, `grouped by ${g.groupedBy}`, `pets ${g.pets}`, `owners ${g.owners}`,
    ...(g.withoutOwner ? [`without owner ${g.withoutOwner}`] : []), `created ${g.created.join(', ')}`].join(' · '));
  const total = (by: SharedNumberGroup['groupedBy']) => {
    const gs = r.groups.filter((g) => g.groupedBy === by);
    return `${gs.length} groups (${gs.reduce((n, g) => n + g.pets, 0)} pets)`;
  };
  lines.push(`shared numbers: by number ${total('number')} · by last 9 ${total('last 9')} · across ${r.clinics} clinics checked (dry run, nothing written)`);
  return lines;
}
