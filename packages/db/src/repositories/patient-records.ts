// SPDX-License-Identifier: AGPL-3.0-only
import { type Gender, namesMatch, normalizeName, parseDob, soundsLike } from '@attendra/core';
import { and, asc, desc, eq, inArray, isNotNull, ne, or, type SQL, sql } from 'drizzle-orm';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { appointments, auditLogs, calls, patients, tasks } from '../schema';
import { patientSetKey, recordView } from './audit';
import { callerKey } from './calls';
import { auditResults } from './front-desk';
import { dobKey, findSameIdentity, patientsWithKey, writeSearchKeys, isSameIdentity, nameWordKeys, patientLookupKey, PHONE_PART_DIGITS, phoneKey, phoneMatch, phonePartKey, readGenderColumn, sealPatient } from './patients';

/**
 * The most patients one search reads. The keyed candidates (searchKeyHashes) are read up to it; the old scan of the
 * newest records, kept behind ATTENDRA_SEARCH_SCAN for one release as the way back, reads exactly this many. Decision 7.
 */
export const PATIENT_SCAN_LIMIT = 20_000;
export const SEARCH_RESULTS = 25;
/** The newest patients the list shows before anything is typed. */
export const NEWEST_PATIENTS = 50;
/** The most numbers "Call as" offers at once, and the newest records it reads before anything is typed. */
export const CALL_AS_NUMBERS = 20;
const CALL_AS_SCAN = 200;

export type PatientStatus = 'active' | 'new';
export interface PatientCard {
  id: string; firstName: string; lastName: string; dob: string;
  /** Null only for someone added before v0.5 made it required: they cannot be verified on a call until it is added. */
  phone: string | null;
  guardianName: string | null;
  /** Null only for a patient from before v0.5.1: the front desk adds it on their record. */
  gender: Gender | null;
  /** The kind of animal, for a pet. */
  species: string | null;
  /** new: added by the assistant on a call, waiting for the front desk to check the details. */
  status: PatientStatus;
  createdAt: Date;
  /** The clinic's own details on the record (Settings, Fields and lists). */
  custom: Record<string, string>;
  /** They agreed to reminder texts: on a call, at the desk, or in an import. */
  textsOk: boolean;
  textsOkSource: 'call' | 'staff' | 'import' | null;
}
export interface PatientFields {
  firstName: string; lastName: string; dob: string; phone: string; guardianName?: string | null; gender?: Gender | null; species?: string | null;
  /** Reminder texts: true they agreed, false they did not; left out, an edit keeps what was there. */
  textsOk?: boolean;
}

/** `similar`: someone else has this name and date of birth with another phone, which is allowed and worth a look. */
export type SaveResult = { status: 'saved'; id: string; similar: boolean } | { status: 'exists'; id: string } | { status: 'not_found' };

const actorOf = (userId: string) => `user:${userId}`;
const words = (s: string) => normalizeName(s).split(' ').filter(Boolean);
const digitsOf = (s: string) => s.replace(/\D/g, '');

/**
 * How a search box's text is read, from the first character typed: a request number
 * written as one ("R-1042", "#1042"), a whole date of birth, some digits of a phone
 * number, or the start of a name. Bare digits are a phone, and are tried as a request
 * number too (readRequestNumber).
 */
export function readQuery(query: string, today = new Date()): { kind: 'request'; number: number } | { kind: 'dob'; dob: string } | { kind: 'phone'; digits: string } | { kind: 'name'; words: string[] } | null {
  const q = query.trim();
  if (!q) return null;
  const written = q.match(/^(?:r[-\s]?|#)(\d{1,9})$/i);
  if (written) return { kind: 'request', number: Number(written[1]) };
  const dob = parseDob(q, today);
  if (dob) return { kind: 'dob', dob };
  if (/^[\d\s()+.-]+$/.test(q) && digitsOf(q)) return { kind: 'phone', digits: digitsOf(q) };
  const w = words(q);
  return w.length ? { kind: 'name', words: w } : null;
}

/** The request number a search box's text could mean: "R-1042", "#1042" or "1042" alone. Null for anything else, and for ten digits or more, which are a phone. */
export function readRequestNumber(query: string): number | null {
  const m = query.trim().match(/^(?:r[-\s]?|#)?(\d{1,9})$/i);
  return m ? Number(m[1]) : null;
}

/** Every word typed starts a word of the name: "del mar" finds Maria Delgado, "m" finds every Maria and Martin. */
export function nameMatches(typed: string[], p: { firstName: string; lastName: string }) {
  const have = [...words(p.firstName), ...words(p.lastName)];
  return typed.every((t) => have.some((h) => h.startsWith(t)));
}

/**
 * A name the way a person types it: first, last or both in any order, each word started
 * or, once it is a whole word, said the way the name sounds ("Danial" finds Daniel, as
 * the assistant hears names on a call).
 */
const spokenMatches = (typed: string[], have: string[]) => have.length > 0 && typed.every((t) => have.some((h) => h.startsWith(t) || soundsLike(t, h)));

/** The owner's (guardian's) name, matched the same way. */
export function ownerNameMatches(typed: string[], guardianName: string | null) {
  return !!guardianName && spokenMatches(typed, words(guardianName));
}

/** What a search matched a record on, so the screen can group and highlight it. */
export type MatchedOn = 'request' | 'name' | 'owner' | 'phone' | 'dob';
export type SearchHit = PatientCard & { matchedOn: MatchedOn };
/** Exact things first (a request number), then the record's own name, then the owner's; a phone that starts with the digits before one that contains them. */
const RANK: Record<MatchedOn, number> = { request: 0, name: 1, owner: 2, dob: 1, phone: 3 };

/** What a search reads of a candidate to match and sort it, each field decrypted only when first asked for. */
type Found = { id: string; firstName: string; lastName: string; guardianName: string | null; phone: string | null; dob: string };
const byName = (a: Found, b: Found) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.dob.localeCompare(b.dob);

/**
 * Patients as the front desk works with them. Names, dates of birth and phone
 * numbers are encrypted, so search reads and decrypts inside the API (decision 7).
 * Every read that shows a patient writes its audit row in the same transaction.
 */
export class PatientRecords {
  /** `scanWindow`: also read and match the newest this many patients on every search, as before v0.10 (ATTENDRA_SEARCH_SCAN). Off when left out. */
  constructor(private readonly db: Database, private readonly cipher: PhiCipher, private readonly opts: { scanWindow?: number } = {}) {}

  /**
   * At most 25 matches, as the person types: by the record's own name, the owner's
   * name (any order, or as it sounds), a phone in any form (whole, or any of its digits),
   * a date of birth, or a request number. Each search writes one patient.searched row with
   * how many matched, and a patient.search.result row for each patient shown that this
   * person was not already shown in the last few minutes (auditResults); what was typed
   * is never written. Says when it stopped at the cap, so the screen can say so.
   */
  async search(clinicId: string, query: string, userId: string, today = new Date(), opts: { status?: PatientStatus } = {}): Promise<{ patients: SearchHit[]; truncated: boolean } | null> {
    const q = readQuery(query, today);
    if (!q) return null;
    return withClinic(this.db, clinicId, async (tx) => {
      const { hits, truncated } = await this.hits(tx, clinicId, q, readRequestNumber(query), opts.status);
      const matched = hits.sort((a, b) => a.rank - b.rank || byName(a.hit, b.hit));
      const shown = matched.slice(0, SEARCH_RESULTS);
      // only the patients shown are read whole
      const rows = shown.length ? await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), inArray(patients.id, shown.map((x) => x.hit.id)))) : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const cards = shown.map((x) => ({ ...this.card(clinicId, byId.get(x.hit.id)!), matchedOn: x.on }));
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.searched', entity: 'patient', entityId: `matches:${matched.length}` });
      await auditResults(tx, clinicId, userId, cards.map((p) => p.id), { fold: true });
      return { patients: cards, truncated };
    });
  }

  /**
   * The records a search matches, each with what it matched on. Candidates come from the
   * keyed hashes alone (searchKeyHashes, patient_search_keys): a whole phone, any run of its digits, the date of
   * birth, the first letters or the sound of every word typed, the patients of a request
   * with the number typed. A typed word of one to three letters is decided by its key; a
   * longer one is decided here, on the decrypted name, where it must start a word of the
   * name or sound like one. A record stored before migration 0049 has no keys until
   * `pnpm db:rehash-lookups --apply` has run.
   */
  private async hits(tx: Tx, clinicId: string, q: NonNullable<ReturnType<typeof readQuery>>, requestNumber: number | null, status?: PatientStatus) {
    const base = and(eq(patients.clinicId, clinicId), status ? eq(patients.status, status) : undefined);
    // the patients of the request with this number, when the clinic numbers its requests (migration 0041)
    const ofRequest = new Set(requestNumber === null ? [] : (await tx.select({ id: tasks.patientId }).from(tasks)
      .where(and(eq(tasks.clinicId, clinicId), eq(tasks.number, requestNumber), isNotNull(tasks.patientId)))).map((t) => t.id!));
    const whole = q.kind === 'phone' && q.digits.length > PHONE_PART_DIGITS;
    const has = (keys: string[]) => inArray(patients.id, patientsWithKey(tx, this.cipher, clinicId, keys));
    const keyed: SQL[] = [];
    if (q.kind === 'phone') keyed.push(whole ? eq(patients.phoneHash, this.cipher.hash(phoneKey(clinicId, q.digits))) : has([phonePartKey(clinicId, q.digits)]));
    else if (q.kind === 'dob') keyed.push(has([dobKey(clinicId, q.dob)]));
    // every word typed must find a key: the record's own name or its owner's has a word that starts like it or sounds like it
    else if (q.kind === 'name') keyed.push(and(...q.words.map((w) => has(nameWordKeys(clinicId, w))))!);
    if (ofRequest.size) keyed.push(inArray(patients.id, [...ofRequest]));
    const columns = { id: patients.id, firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc, guardianNameEnc: patients.guardianNameEnc, phoneEnc: patients.phoneEnc, dobEnc: patients.dobEnc };
    const byKey = keyed.length ? await tx.select(columns).from(patients).where(and(base, or(...keyed))).orderBy(asc(patients.id)).limit(PATIENT_SCAN_LIMIT) : [];
    // the way back for one release (ATTENDRA_SEARCH_SCAN): the newest records read and matched on every search, as before
    const window = this.opts.scanWindow;
    const scanned = !window || whole || q.kind === 'request' ? [] : await tx.select(columns).from(patients).where(base).orderBy(asc(patients.id)).limit(window);
    const rows = new Map([...byKey, ...scanned].map((r) => [r.id, r]));
    const hits: { hit: Found; on: MatchedOn; rank: number }[] = [];
    for (const r of rows.values()) {
      const c = this.found(clinicId, r);
      const m = this.matchOf(q, c, ofRequest);
      if (m) hits.push({ hit: c, on: m.on, rank: m.rank });
    }
    return { hits, truncated: byKey.length >= PATIENT_SCAN_LIMIT || (!!window && scanned.length >= window) };
  }

  /** A candidate as a search reads it: each field decrypted the first time it is asked for, so matching a name never decrypts a phone. */
  private found(clinicId: string, r: { id: string; firstNameEnc: string; lastNameEnc: string; guardianNameEnc: string | null; phoneEnc: string | null; dobEnc: string }): Found {
    const memo = new Map<string, string | null>();
    const read = (col: string, enc: string | null) => {
      if (!memo.has(col)) memo.set(col, enc ? this.cipher.decrypt(enc, phiContext(clinicId, `patients.${col}`)) : null);
      return memo.get(col)!;
    };
    return {
      id: r.id,
      get firstName() { return read('first_name', r.firstNameEnc)!; },
      get lastName() { return read('last_name', r.lastNameEnc)!; },
      get guardianName() { return read('guardian_name', r.guardianNameEnc); },
      get phone() { return read('phone', r.phoneEnc); },
      get dob() { return read('dob', r.dobEnc)!; },
    };
  }

  private matchOf(q: NonNullable<ReturnType<typeof readQuery>>, c: Found, ofRequest: Set<string>): { on: MatchedOn; rank: number } | null {
    if (ofRequest.has(c.id)) return { on: 'request', rank: RANK.request };
    if (q.kind === 'dob') return c.dob === q.dob ? { on: 'dob', rank: RANK.dob } : null;
    if (q.kind === 'phone') {
      // numbers that start with what was typed first, then numbers that contain it
      const m = phoneMatch(q.digits, c.phone);
      return m === null ? null : { on: 'phone', rank: RANK.phone + m };
    }
    if (q.kind === 'name') {
      if (nameMatches(q.words, c) || spokenMatches(q.words, [...words(c.firstName), ...words(c.lastName)])) return { on: 'name', rank: RANK.name };
      if (ownerNameMatches(q.words, c.guardianName)) return { on: 'owner', rank: RANK.owner };
    }
    return null;
  }

  /** The newest patients first, for the list before anything is typed. `status: 'new'` lists those waiting to be checked. */
  async newest(clinicId: string, userId: string, opts: { status?: PatientStatus; limit?: number } = {}): Promise<PatientCard[]> {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select().from(patients)
        .where(and(eq(patients.clinicId, clinicId), opts.status ? eq(patients.status, opts.status) : undefined))
        .orderBy(desc(patients.createdAt), desc(patients.id)).limit(opts.limit ?? NEWEST_PATIENTS);
      const cards = rows.map((r) => this.card(clinicId, r));
      await recordView(tx, { clinicId, actor: actorOf(userId), action: 'patient.list.viewed', entity: 'patient', entityId: patientSetKey(cards.map((c) => c.id)) }, 5);
      return cards;
    });
  }

  /**
   * Patients by kind of animal or by one of the clinic's own fields, newest first: the
   * details are encrypted, so the newest few thousand are read and checked here. At
   * most 100 are shown; audited like the list.
   */
  async filtered(clinicId: string, userId: string, f: { species?: string; field?: { id: string; value: string; multi: boolean } }): Promise<{ patients: PatientCard[]; truncated: boolean }> {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select().from(patients).where(eq(patients.clinicId, clinicId)).orderBy(desc(patients.createdAt), desc(patients.id)).limit(PATIENT_SCAN_LIMIT);
      const want = (v: string | undefined) => (v ?? '').trim().toLowerCase();
      const match = (c: PatientCard) => (!f.species || want(c.species ?? '') === want(f.species))
        && (!f.field || (f.field.multi
          ? (c.custom[f.field.id] ?? '').split('|').map(want).includes(want(f.field.value))
          : want(c.custom[f.field.id]) === want(f.field.value)));
      const all = rows.map((r) => this.card(clinicId, r)).filter(match);
      const shown = all.slice(0, 100);
      await recordView(tx, { clinicId, actor: actorOf(userId), action: 'patient.list.viewed', entity: 'patient', entityId: patientSetKey(shown.map((c) => c.id)) }, 5);
      return { patients: shown, truncated: all.length > shown.length || rows.length >= PATIENT_SCAN_LIMIT };
    });
  }

  /** How many patients the assistant added that nobody has checked yet. Counts only, no patient data. */
  async newCount(clinicId: string): Promise<number> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.status, 'new'))) as [{ n: number }];
      return n;
    });
  }

  /**
   * One patient with their household (everyone on the same phone: an owner's pets, a parent's
   * children), appointments, and, as one profile for that phone number, every call from the
   * number (verified or not) and the requests of anyone on it or from those calls.
   */
  async profile(clinicId: string, patientId: string, userId: string) {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)));
      if (!row) return null;
      // everyone on the same phone: a parent and their children, an owner's pets
      const family = row.phoneHash
        ? await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, row.phoneHash), ne(patients.id, patientId))).limit(20)
        : [];
      const phoneNumber = this.card(clinicId, row).phone;
      const fromHash = phoneNumber ? this.cipher.hash(callerKey(clinicId, phoneNumber)) : null;
      const visits = await tx.select().from(appointments).where(and(eq(appointments.clinicId, clinicId), eq(appointments.patientId, patientId))).orderBy(desc(appointments.startsAt));
      const theirCalls = await tx.select({ id: calls.id, startedAt: calls.startedAt, outcome: calls.outcome, emergency: calls.emergencyFlag, channel: calls.channel, voiceSeconds: calls.voiceSeconds, patientId: calls.patientId })
        .from(calls).where(and(eq(calls.clinicId, clinicId), fromHash ? or(eq(calls.patientId, patientId), eq(calls.fromHash, fromHash)) : eq(calls.patientId, patientId)))
        .orderBy(desc(calls.startedAt)).limit(100);
      const onPhone = [patientId, ...family.map((f) => f.id)];
      const callIds = theirCalls.map((c) => c.id);
      const requests = await tx.select().from(tasks).where(and(eq(tasks.clinicId, clinicId),
        callIds.length ? or(inArray(tasks.patientId, onPhone), inArray(tasks.callId, callIds)) : inArray(tasks.patientId, onPhone)))
        .orderBy(desc(tasks.createdAt)).limit(100);
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.viewed', entity: 'patient', entityId: patientId });
      await auditResults(tx, clinicId, userId, family.map((f) => f.id));
      return {
        ...this.card(clinicId, row),
        createdByCallId: row.createdByCallId,
        customFields: row.customEnc ? JSON.parse(this.cipher.decrypt(row.customEnc, phiContext(clinicId, 'patients.custom'))) as Record<string, string> : {},
        household: family.map((f) => this.card(clinicId, f)).sort((a, b) => a.dob.localeCompare(b.dob)),
        appointments: visits,
        calls: theirCalls.map(({ patientId: about, ...c }) => ({ ...c, voiceSeconds: c.voiceSeconds === null ? null : Number(c.voiceSeconds), forThisRecord: about === patientId })),
        requests: requests.map((t) => ({
          id: t.id, number: t.number, type: t.type, patientId: t.patientId, status: t.status, callId: t.callId, createdAt: t.createdAt, doneAt: t.doneAt,
          details: JSON.parse(this.cipher.decrypt(t.detailsEnc, phiContext(clinicId, 'tasks.details'))) as Record<string, string>,
        })),
      };
    });
  }

  /** The last 10 patients this person opened, newest first. */
  async recent(clinicId: string, userId: string): Promise<PatientCard[]> {
    return withClinic(this.db, clinicId, async (tx) => {
      const opened = await tx.select({ id: auditLogs.entityId, last: sql<number>`max(${auditLogs.id})` }).from(auditLogs)
        .where(and(eq(auditLogs.clinicId, clinicId), eq(auditLogs.actor, actorOf(userId)), eq(auditLogs.action, 'patient.viewed'), isNotNull(auditLogs.entityId)))
        .groupBy(auditLogs.entityId).orderBy(desc(sql`max(${auditLogs.id})`)).limit(10);
      const ids = opened.map((o) => o.id!).filter((id) => /^[0-9a-f-]{36}$/.test(id));
      if (!ids.length) return [];
      const rows = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), inArray(patients.id, ids)));
      await recordView(tx, { clinicId, actor: actorOf(userId), action: 'patient.recent.viewed', entity: 'patient', entityId: patientSetKey(rows.map((r) => r.id)) }, 5);
      const byId = new Map(rows.map((r) => [r.id, this.card(clinicId, r)]));
      return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    });
  }

  /**
   * Adds a patient. The hashes are computed exactly as the voice path computes them,
   * so the assistant can verify this person on their next call. The same person (name,
   * date of birth and phone) already on file is refused; a brother on the same phone,
   * or a stranger with the same name and birthday on another phone, is not.
   */
  async create(clinicId: string, p: PatientFields, userId: string): Promise<SaveResult> {
    return withClinic(this.db, clinicId, (tx) => this.insert(tx, clinicId, p, actorOf(userId), 'staff'));
  }

  /** The import's way in: the same checks as one patient added by hand, in the caller's transaction. */
  async insert(tx: Tx, clinicId: string, p: PatientFields, actor: string, source: 'staff' | 'import' = 'import'): Promise<SaveResult> {
    const same = await findSameIdentity(tx, this.cipher, clinicId, p);
    if (same) return { status: 'exists', id: same };
    const similar = await this.similar(tx, clinicId, p);
    try {
      // in a savepoint, so the same person added by someone else a moment ago ends this insert, not the whole import
      const row = await tx.transaction(async (sp) => {
        const consent = p.textsOk ? { smsConsentAt: new Date(), smsConsentSource: source } : {};
        const [r] = await sp.insert(patients).values({ clinicId, ...sealPatient(this.cipher, clinicId, p), ...consent }).returning({ id: patients.id });
        await writeSearchKeys(sp, this.cipher, clinicId, r!.id, p);
        await sp.insert(auditLogs).values({ clinicId, actor, action: 'patient.created', entity: 'patient', entityId: r!.id });
        return r!;
      });
      return { status: 'saved', id: row.id, similar };
    } catch (err) {
      if (!isSameIdentity(err)) throw err;
      return { status: 'exists', id: (await findSameIdentity(tx, this.cipher, clinicId, p))! };
    }
  }

  /** Replaces a patient's details, recomputing every hash. */
  async update(clinicId: string, patientId: string, p: PatientFields, userId: string): Promise<SaveResult> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select({ id: patients.id, smsConsentAt: patients.smsConsentAt }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)));
      if (!row) return { status: 'not_found' };
      const same = await findSameIdentity(tx, this.cipher, clinicId, p, patientId);
      if (same) return { status: 'exists', id: same };
      const similar = await this.similar(tx, clinicId, p, patientId);
      // a yes already on file keeps when and how it was given
      const consent = p.textsOk === undefined || p.textsOk === !!row.smsConsentAt ? {}
        : p.textsOk ? { smsConsentAt: new Date(), smsConsentSource: 'staff' as const } : { smsConsentAt: null, smsConsentSource: null };
      await tx.update(patients).set({ ...sealPatient(this.cipher, clinicId, p), ...consent }).where(eq(patients.id, patientId));
      await writeSearchKeys(tx, this.cipher, clinicId, patientId, p);
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.updated', entity: 'patient', entityId: patientId });
      return { status: 'saved', id: patientId, similar };
    });
  }

  /** Replaces the clinic's own details on a record (already checked against its fields). Audited, without the values. */
  async setCustomFields(clinicId: string, patientId: string, values: Record<string, string>, userId: string): Promise<'saved' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const customEnc = Object.keys(values).length ? this.cipher.encrypt(JSON.stringify(values), phiContext(clinicId, 'patients.custom')) : null;
      const [row] = await tx.update(patients).set({ customEnc }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId))).returning({ id: patients.id });
      if (!row) return 'not_found';
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.fields.updated', entity: 'patient', entityId: patientId });
      return 'saved';
    });
  }

  /**
   * The front desk has checked a patient the assistant added: they become an ordinary
   * patient, and the open request to check them is closed with that outcome.
   */
  async confirm(clinicId: string, patientId: string, userId: string): Promise<'confirmed' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.update(patients).set({ status: 'active' }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId), eq(patients.status, 'new'))).returning({ id: patients.id });
      if (!row) return 'not_found';
      await tx.update(tasks).set({ status: 'done', doneAt: new Date(), doneByUserId: userId, outcome: 'details_confirmed' })
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.patientId, patientId), eq(tasks.type, 'review'), eq(tasks.status, 'open')));
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.confirmed', entity: 'patient', entityId: patientId });
      return 'confirmed';
    });
  }

  /** Names for patient ids, for lists that show them next to something else (a call, a request). No audit row: the caller writes its own. */
  async names(tx: Tx, clinicId: string, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), inArray(patients.id, unique)));
    return new Map(rows.map((r) => { const c = this.card(clinicId, r); return [r.id, `${c.firstName} ${c.lastName}`]; }));
  }

  /**
   * The numbers on file a browser test call can be started as ("Call as"): one per
   * household (everyone on one phone), labelled with the owner's first name and the
   * number's last four digits, never the whole number; at most CALL_AS_NUMBERS. Found
   * the way the patient search finds records (a name, the owner's name, some digits);
   * with nothing typed, the newest records. Audited like a search or the list: how many
   * and which records, never what was typed.
   */
  async callAsNumbers(clinicId: string, query: string, userId: string, today = new Date()): Promise<{ patientId: string; label: string }[]> {
    const q = query.trim() ? readQuery(query, today) : null;
    if (query.trim() && !q) return [];
    return withClinic(this.db, clinicId, async (tx) => {
      const cards: Found[] = q
        ? (await this.hits(tx, clinicId, q, null)).hits.sort((a, b) => a.rank - b.rank || byName(a.hit, b.hit)).map((x) => x.hit)
        : (await tx.select().from(patients).where(eq(patients.clinicId, clinicId)).orderBy(desc(patients.createdAt), desc(patients.id)).limit(CALL_AS_SCAN)).map((r) => this.found(clinicId, r));
      // in the order found, one row per phone: the owner's own record when it is there
      const households = new Map<string, Found[]>();
      for (const c of cards) {
        if (!c.phone) continue;
        const key = c.phone.replace(/\D/g, '').slice(-10);
        households.set(key, [...(households.get(key) ?? []), c]);
      }
      const numbers = [...households.values()].slice(0, CALL_AS_NUMBERS).map((members) => {
        const guardian = members.find((m) => m.guardianName)?.guardianName ?? null;
        const own = members.find((m) => !m.guardianName) ?? members[0]!;
        const owner = (guardian ?? own.firstName).trim().split(/\s+/)[0] ?? '';
        return { patientId: own.id, label: `${owner} · …${own.phone!.replace(/\D/g, '').slice(-4)}` };
      });
      const ids = numbers.map((n) => n.patientId);
      if (q) {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.searched', entity: 'patient', entityId: `matches:${ids.length}` });
        await auditResults(tx, clinicId, userId, ids, { fold: true });
      } else if (ids.length) {
        await recordView(tx, { clinicId, actor: actorOf(userId), action: 'patient.list.viewed', entity: 'patient', entityId: patientSetKey(ids) }, 5);
      }
      return numbers;
    });
  }

  /**
   * The phone on one record, for a browser test call started as it ("Call as"). Null when
   * this clinic has no such record (another clinic's is hidden by its row policy) or it
   * has no phone. Audited: a staff member used this record's number.
   */
  async phoneOf(clinicId: string, patientId: string, userId: string): Promise<string | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [r] = await tx.select({ phoneEnc: patients.phoneEnc }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)));
      if (!r?.phoneEnc) return null;
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.phone.called_as', entity: 'patient', entityId: patientId });
      return this.cipher.decrypt(r.phoneEnc, phiContext(clinicId, 'patients.phone'));
    });
  }

  /** Every patient whose own or owner's name matches the words, for searches that go through another table (a patient's calls). Not audited here: the search that uses it is. */
  async idsMatching(clinicId: string, query: string): Promise<string[]> {
    return withClinic(this.db, clinicId, (tx) => this.idsByName(tx, clinicId, query));
  }

  async idsByName(tx: Tx, clinicId: string, query: string): Promise<string[]> {
    const w = words(query);
    if (!w.length) return [];
    return (await this.hits(tx, clinicId, { kind: 'name', words: w }, null)).hits.map((h) => h.hit.id);
  }

  /** Someone else on file with this name and date of birth, on another phone. */
  private async similar(tx: Tx, clinicId: string, p: PatientFields, except?: string) {
    const rows = await tx.select().from(patients)
      .where(and(eq(patients.clinicId, clinicId), eq(patients.lookupHash, this.cipher.hash(patientLookupKey(clinicId, `${p.firstName} ${p.lastName}`, p.dob)))));
    return rows.some((r) => r.id !== except && namesMatch(`${p.firstName} ${p.lastName}`, `${this.card(clinicId, r).firstName} ${this.card(clinicId, r).lastName}`));
  }

  card(clinicId: string, r: typeof patients.$inferSelect): PatientCard {
    const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
    return {
      id: r.id,
      firstName: this.cipher.decrypt(r.firstNameEnc, ctx('first_name')),
      lastName: this.cipher.decrypt(r.lastNameEnc, ctx('last_name')),
      dob: this.cipher.decrypt(r.dobEnc, ctx('dob')),
      phone: r.phoneEnc ? this.cipher.decrypt(r.phoneEnc, ctx('phone')) : null,
      guardianName: r.guardianNameEnc ? this.cipher.decrypt(r.guardianNameEnc, ctx('guardian_name')) : null,
      gender: readGenderColumn(this.cipher, clinicId, r.genderEnc),
      species: r.speciesEnc ? this.cipher.decrypt(r.speciesEnc, ctx('species')) : null,
      status: r.status,
      createdAt: r.createdAt,
      custom: r.customEnc ? JSON.parse(this.cipher.decrypt(r.customEnc, ctx('custom'))) as Record<string, string> : {},
      textsOk: !!r.smsConsentAt,
      textsOkSource: r.smsConsentAt ? r.smsConsentSource : null,
    };
  }
}
