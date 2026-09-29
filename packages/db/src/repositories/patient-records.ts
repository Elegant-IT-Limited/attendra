// SPDX-License-Identifier: AGPL-3.0-only
import { namesMatch, normalizeName, parseDob } from '@attendra/core';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { appointments, auditLogs, calls, patients, tasks } from '../schema';
import { recordView } from './audit';
import { patientLookupKey, phoneKey } from './patients';

/** The most patients one search will read. Decision 7 says why, and what replaces it. */
export const PATIENT_SCAN_LIMIT = 20_000;
export const SEARCH_RESULTS = 25;

export interface PatientCard { id: string; firstName: string; lastName: string; dob: string; phone: string | null }
export interface PatientFields { firstName: string; lastName: string; dob: string; phone?: string | null }

export type SaveResult = { status: 'saved'; id: string } | { status: 'exists'; id: string } | { status: 'not_found' };

const actorOf = (userId: string) => `user:${userId}`;
const words = (s: string) => normalizeName(s).split(' ').filter(Boolean);

/** How a search box's text is read: a date of birth, a full phone number, or a name. */
export function readQuery(query: string, today = new Date()): { kind: 'dob'; dob: string } | { kind: 'phone'; digits: string } | { kind: 'name'; words: string[] } | null {
  const q = query.trim();
  const dob = parseDob(q, today);
  if (dob) return { kind: 'dob', dob };
  const digits = q.replace(/\D/g, '');
  if (/^[\d\s()+.-]+$/.test(q) && digits.length >= 10) return { kind: 'phone', digits: digits.slice(-10) };
  const w = words(q);
  return w.length && w.join('').length >= 2 ? { kind: 'name', words: w } : null;
}

/** Every word typed starts a word of the name: "del mar" finds Maria Delgado. */
export function nameMatches(typed: string[], p: { firstName: string; lastName: string }) {
  const have = [...words(p.firstName), ...words(p.lastName)];
  return typed.every((t) => have.some((h) => h.startsWith(t)));
}

/**
 * Patients as the front desk works with them. Names and dates of birth are
 * encrypted, so search reads and decrypts inside the API (decision 7). Every read
 * that shows a patient writes its audit row in the same transaction.
 */
export class PatientRecords {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher) {}

  /** At most 25 matches, by last name. The audit row records how many matched, never what was typed. */
  async search(clinicId: string, query: string, userId: string, today = new Date()): Promise<PatientCard[] | null> {
    const q = readQuery(query, today);
    if (!q) return null;
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = q.kind === 'phone'
        ? await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.phoneHash, this.cipher.hash(phoneKey(clinicId, q.digits)))))
        : await tx.select().from(patients).where(eq(patients.clinicId, clinicId)).limit(PATIENT_SCAN_LIMIT);
      const cards = rows.map((r) => this.card(clinicId, r));
      const matched = cards.filter((c) => q.kind === 'phone' || (q.kind === 'dob' ? c.dob === q.dob : nameMatches(q.words, c)))
        .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.dob.localeCompare(b.dob));
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.searched', entity: 'patient', entityId: `matches:${matched.length}` });
      return matched.slice(0, SEARCH_RESULTS);
    });
  }

  /** One patient with their appointments, the calls they were verified on, and their requests. */
  async profile(clinicId: string, patientId: string, userId: string) {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)));
      if (!row) return null;
      const visits = await tx.select().from(appointments).where(and(eq(appointments.clinicId, clinicId), eq(appointments.patientId, patientId))).orderBy(desc(appointments.startsAt));
      const theirCalls = await tx.select({ id: calls.id, startedAt: calls.startedAt, outcome: calls.outcome, emergency: calls.emergencyFlag, channel: calls.channel, voiceSeconds: calls.voiceSeconds })
        .from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.patientId, patientId))).orderBy(desc(calls.startedAt)).limit(100);
      const requests = await tx.select().from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.patientId, patientId))).orderBy(desc(tasks.createdAt)).limit(100);
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.viewed', entity: 'patient', entityId: patientId });
      return {
        ...this.card(clinicId, row),
        createdAt: row.createdAt,
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
      await recordView(tx, { clinicId, actor: actorOf(userId), action: 'patient.recent.viewed', entity: 'patient', entityId: null }, 5);
      const byId = new Map(rows.map((r) => [r.id, this.card(clinicId, r)]));
      return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    });
  }

  /**
   * Adds a patient. The lookup and phone hashes are computed exactly as the voice
   * path computes them, so the assistant can verify this person on their next call.
   * Someone with the same name and date of birth already on file is refused.
   */
  async create(clinicId: string, p: PatientFields, userId: string): Promise<SaveResult> {
    return withClinic(this.db, clinicId, async (tx) => {
      const same = await this.sameIdentity(tx, clinicId, p);
      if (same) return { status: 'exists', id: same };
      const [row] = await tx.insert(patients).values({ clinicId, ...this.sealed(clinicId, p) }).returning({ id: patients.id });
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.created', entity: 'patient', entityId: row!.id });
      return { status: 'saved', id: row!.id };
    });
  }

  /** Replaces a patient's details, recomputing both hashes. */
  async update(clinicId: string, patientId: string, p: PatientFields, userId: string): Promise<SaveResult> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)));
      if (!row) return { status: 'not_found' };
      const same = await this.sameIdentity(tx, clinicId, p, patientId);
      if (same) return { status: 'exists', id: same };
      await tx.update(patients).set(this.sealed(clinicId, p)).where(eq(patients.id, patientId));
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.updated', entity: 'patient', entityId: patientId });
      return { status: 'saved', id: patientId };
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
    const rows = await tx.select().from(patients)
      .where(and(eq(patients.clinicId, clinicId), eq(patients.lookupHash, this.cipher.hash(patientLookupKey(clinicId, `${p.firstName} ${p.lastName}`, p.dob)))));
    const hit = rows.find((r) => r.id !== except && namesMatch(`${p.firstName} ${p.lastName}`, `${this.card(clinicId, r).firstName} ${this.card(clinicId, r).lastName}`));
    return hit?.id ?? null;
  }

  private sealed(clinicId: string, p: PatientFields) {
    const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
    const phone = p.phone?.trim() || null;
    return {
      lookupHash: this.cipher.hash(patientLookupKey(clinicId, `${p.firstName} ${p.lastName}`, p.dob)),
      firstNameEnc: this.cipher.encrypt(p.firstName.trim(), ctx('first_name')),
      lastNameEnc: this.cipher.encrypt(p.lastName.trim(), ctx('last_name')),
      dobEnc: this.cipher.encrypt(p.dob, ctx('dob')),
      phoneEnc: phone ? this.cipher.encrypt(phone, ctx('phone')) : null,
      phoneHash: phone ? this.cipher.hash(phoneKey(clinicId, phone)) : null,
    };
  }

  private card(clinicId: string, r: typeof patients.$inferSelect): PatientCard {
    const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
    return {
      id: r.id,
      firstName: this.cipher.decrypt(r.firstNameEnc, ctx('first_name')),
      lastName: this.cipher.decrypt(r.lastNameEnc, ctx('last_name')),
      dob: this.cipher.decrypt(r.dobEnc, ctx('dob')),
      phone: r.phoneEnc ? this.cipher.decrypt(r.phoneEnc, ctx('phone')) : null,
    };
  }
}
