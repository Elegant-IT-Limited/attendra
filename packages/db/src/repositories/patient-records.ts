// SPDX-License-Identifier: AGPL-3.0-only
import { namesMatch, normalizeName, parseDob } from '@attendra/core';
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { appointments, auditLogs, calls, patients, tasks } from '../schema';
import { patientSetKey, recordView } from './audit';
import { auditResults } from './front-desk';
import { identityKey, patientLookupKey, sealPatient } from './patients';

/** The most patients one search will read. Decision 7 says why, and what replaces it. */
export const PATIENT_SCAN_LIMIT = 20_000;
export const SEARCH_RESULTS = 25;
/** The newest patients the list shows before anything is typed. */
export const NEWEST_PATIENTS = 50;

export type PatientStatus = 'active' | 'new';
export interface PatientCard {
  id: string; firstName: string; lastName: string; dob: string;
  /** Null only for someone added before v0.5 made it required: they cannot be verified on a call until it is added. */
  phone: string | null;
  guardianName: string | null;
  /** new: added by the assistant on a call, waiting for the front desk to check the details. */
  status: PatientStatus;
  createdAt: Date;
}
export interface PatientFields { firstName: string; lastName: string; dob: string; phone: string; guardianName?: string | null }

/** `similar`: someone else has this name and date of birth with another phone, which is allowed and worth a look. */
export type SaveResult = { status: 'saved'; id: string; similar: boolean } | { status: 'exists'; id: string } | { status: 'not_found' };

const actorOf = (userId: string) => `user:${userId}`;
const words = (s: string) => normalizeName(s).split(' ').filter(Boolean);
const digitsOf = (s: string) => s.replace(/\D/g, '');

/**
 * How a search box's text is read, from the first character typed: a whole date of
 * birth, some digits of a phone number, or the start of a name.
 */
export function readQuery(query: string, today = new Date()): { kind: 'dob'; dob: string } | { kind: 'phone'; digits: string } | { kind: 'name'; words: string[] } | null {
  const q = query.trim();
  if (!q) return null;
  const dob = parseDob(q, today);
  if (dob) return { kind: 'dob', dob };
  if (/^[\d\s()+.-]+$/.test(q) && digitsOf(q)) return { kind: 'phone', digits: digitsOf(q) };
  const w = words(q);
  return w.length ? { kind: 'name', words: w } : null;
}

/** Every word typed starts a word of the name: "del mar" finds Maria Delgado, "m" finds every Maria and Martin. */
export function nameMatches(typed: string[], p: { firstName: string; lastName: string }) {
  const have = [...words(p.firstName), ...words(p.lastName)];
  return typed.every((t) => have.some((h) => h.startsWith(t)));
}

/**
 * Where typed digits sit in a phone number: 0 when the number starts with them (as
 * written with or without its country code, or with a leading 0 the way many
 * countries dial at home), 1 when they are somewhere inside it, null when not at all.
 */
export function phoneMatch(typed: string, phone: string | null): 0 | 1 | null {
  if (!phone) return null;
  const all = digitsOf(phone);
  const national = all.slice(-10);
  const forms = [all, national, `0${national}`];
  if (forms.some((f) => f.startsWith(typed))) return 0;
  return forms.some((f) => f.includes(typed)) ? 1 : null;
}

const byName = (a: PatientCard, b: PatientCard) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.dob.localeCompare(b.dob);

/**
 * Patients as the front desk works with them. Names, dates of birth and phone
 * numbers are encrypted, so search reads and decrypts inside the API (decision 7).
 * Every read that shows a patient writes its audit row in the same transaction.
 */
export class PatientRecords {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher, private readonly scanLimit = PATIENT_SCAN_LIMIT) {}

  /**
   * At most 25 matches, as the person types. Every patient shown gets a
   * patient.search.result row, and the search one row with how many matched; what was
   * typed is never written. The scan reads in a fixed order and says when it stopped
   * at the cap, so the same search always sees the same patients and the screen can say so.
   */
  async search(clinicId: string, query: string, userId: string, today = new Date(), opts: { status?: PatientStatus } = {}): Promise<{ patients: PatientCard[]; truncated: boolean } | null> {
    const q = readQuery(query, today);
    if (!q) return null;
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select().from(patients)
        .where(and(eq(patients.clinicId, clinicId), opts.status ? eq(patients.status, opts.status) : undefined))
        .orderBy(asc(patients.id)).limit(this.scanLimit);
      const cards = rows.map((r) => this.card(clinicId, r));
      let matched: PatientCard[];
      if (q.kind === 'phone') {
        // numbers that start with what was typed first, then numbers that contain it
        const ranked = cards.flatMap((c) => { const m = phoneMatch(q.digits, c.phone); return m === null ? [] : [{ c, m }]; });
        matched = ranked.sort((a, b) => a.m - b.m || byName(a.c, b.c)).map((x) => x.c);
      } else {
        matched = cards.filter((c) => (q.kind === 'dob' ? c.dob === q.dob : nameMatches(q.words, c))).sort(byName);
      }
      const shown = matched.slice(0, SEARCH_RESULTS);
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.searched', entity: 'patient', entityId: `matches:${matched.length}` });
      await auditResults(tx, clinicId, userId, shown.map((p) => p.id));
      return { patients: shown, truncated: rows.length >= this.scanLimit };
    });
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

  /** How many patients the assistant added that nobody has checked yet. Counts only, no patient data. */
  async newCount(clinicId: string): Promise<number> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.status, 'new'))) as [{ n: number }];
      return n;
    });
  }

  /** One patient with their household, appointments, the calls they were verified on, and their requests. */
  async profile(clinicId: string, patientId: string, userId: string) {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)));
      if (!row) return null;
      const visits = await tx.select().from(appointments).where(and(eq(appointments.clinicId, clinicId), eq(appointments.patientId, patientId))).orderBy(desc(appointments.startsAt));
      const theirCalls = await tx.select({ id: calls.id, startedAt: calls.startedAt, outcome: calls.outcome, emergency: calls.emergencyFlag, channel: calls.channel, voiceSeconds: calls.voiceSeconds })
        .from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.patientId, patientId))).orderBy(desc(calls.startedAt)).limit(100);
      const requests = await tx.select().from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.patientId, patientId))).orderBy(desc(tasks.createdAt)).limit(100);
      // everyone on the same phone: a parent and their children
      const family = row.phoneHash
        ? await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, row.phoneHash), ne(patients.id, patientId))).limit(20)
        : [];
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.viewed', entity: 'patient', entityId: patientId });
      await auditResults(tx, clinicId, userId, family.map((f) => f.id));
      return {
        ...this.card(clinicId, row),
        createdByCallId: row.createdByCallId,
        household: family.map((f) => this.card(clinicId, f)).sort((a, b) => a.dob.localeCompare(b.dob)),
        appointments: visits,
        calls: theirCalls.map((c) => ({ ...c, voiceSeconds: c.voiceSeconds === null ? null : Number(c.voiceSeconds) })),
        requests: requests.map((t) => ({
          id: t.id, type: t.type, status: t.status, callId: t.callId, createdAt: t.createdAt, doneAt: t.doneAt,
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
    return withClinic(this.db, clinicId, (tx) => this.insert(tx, clinicId, p, actorOf(userId)));
  }

  /** The import's way in: the same checks as one patient added by hand, in the caller's transaction. */
  async insert(tx: Tx, clinicId: string, p: PatientFields, actor: string): Promise<SaveResult> {
    const same = await this.sameIdentity(tx, clinicId, p);
    if (same) return { status: 'exists', id: same };
    const similar = await this.similar(tx, clinicId, p);
    const [row] = await tx.insert(patients).values({ clinicId, ...sealPatient(this.cipher, clinicId, p) }).returning({ id: patients.id });
    await tx.insert(auditLogs).values({ clinicId, actor, action: 'patient.created', entity: 'patient', entityId: row!.id });
    return { status: 'saved', id: row!.id, similar };
  }

  /** Replaces a patient's details, recomputing every hash. */
  async update(clinicId: string, patientId: string, p: PatientFields, userId: string): Promise<SaveResult> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)));
      if (!row) return { status: 'not_found' };
      const same = await this.sameIdentity(tx, clinicId, p, patientId);
      if (same) return { status: 'exists', id: same };
      const similar = await this.similar(tx, clinicId, p, patientId);
      await tx.update(patients).set(sealPatient(this.cipher, clinicId, p)).where(eq(patients.id, patientId));
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.updated', entity: 'patient', entityId: patientId });
      return { status: 'saved', id: patientId, similar };
    });
  }

  /**
   * The front desk has checked a patient the assistant added: they become an ordinary
   * patient, and the open request to check them is closed with that outcome.
   */
  async confirm(clinicId: string, patientId: string, userId: string): Promise<'confirmed' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.update(patients).set({ status: 'active' }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId))).returning({ id: patients.id });
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

  /** Every patient whose name matches the words, for searches that go through another table (a patient's calls). Not audited here: the search that uses it is. */
  async idsMatching(clinicId: string, query: string): Promise<string[]> {
    return withClinic(this.db, clinicId, (tx) => this.idsByName(tx, clinicId, query));
  }

  async idsByName(tx: Tx, clinicId: string, query: string): Promise<string[]> {
    const w = words(query);
    if (!w.length) return [];
    const rows = await tx.select().from(patients).where(eq(patients.clinicId, clinicId)).orderBy(asc(patients.id)).limit(PATIENT_SCAN_LIMIT);
    return rows.map((r) => this.card(clinicId, r)).filter((c) => nameMatches(w, c)).map((c) => c.id);
  }

  private async sameIdentity(tx: Tx, clinicId: string, p: PatientFields, except?: string) {
    const rows = await tx.select({ id: patients.id }).from(patients)
      .where(and(eq(patients.clinicId, clinicId), eq(patients.identityHash, this.cipher.hash(identityKey(clinicId, p.firstName, p.lastName, p.dob, p.phone)))));
    return rows.find((r) => r.id !== except)?.id ?? null;
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
      status: r.status,
      createdAt: r.createdAt,
    };
  }
}
