// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeName } from '@attendra/core';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import { clinicAccess, clinicMemberships, memberships } from '../auth-schema';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { patientSetKey, recordView } from './audit';
import { callerKey, callerPartKey } from './calls';
import { nameWordKeys, patientsWithKey, PHONE_PART_DIGITS, searchHash, phoneKey, phoneMatch, phonePartKey } from './patients';
import { appointments, auditLogs, callActions, calls, callSearchKeys, callSegments, callSummaries, clinics, organizations, patients, smsMessages, taskNotes, tasks } from '../schema';
import { decryptSummary } from './summaries';

export type StaffRole = 'owner' | 'admin' | 'staff' | 'viewer';
export type TaskOutcome = 'called_back' | 'left_message' | 'refill_sent' | 'refill_ready' | 'refill_declined' | 'not_needed' | 'details_confirmed';
const TASK_TYPES = ['callback', 'refill', 'voicemail', 'review', 'follow_up'] as const;
type TaskType = (typeof TASK_TYPES)[number];

/**
 * Which clinics a signed-in person can open, and with which role: every location of a
 * business they own, and each location they were invited to (clinic_access, migration
 * 0046). Runs as the owner connection because it decides the tenant; everything after it
 * runs inside withClinic for the clinic it returns.
 */
export async function clinicsForUser(db: Database, userId: string) {
  return db.select({ clinicId: clinics.id, clinicName: clinics.name, timezone: clinics.timezone, orgId: clinics.orgId, orgName: organizations.name, role: clinicAccess.role, approvesRefills: clinicAccess.approvesRefills, accountWide: clinicAccess.accountWide })
    .from(clinicAccess).innerJoin(clinics, eq(clinics.id, clinicAccess.clinicId)).innerJoin(organizations, eq(organizations.id, clinics.orgId))
    .where(and(eq(clinicAccess.userId, userId), isNull(clinics.closedAt))).orderBy(organizations.name, clinics.name);
}

export async function staffRole(db: Database, userId: string, clinicId: string): Promise<StaffRole | null> {
  const [row] = await db.select({ role: clinicAccess.role }).from(clinicAccess)
    .innerJoin(clinics, eq(clinics.id, clinicAccess.clinicId))
    .where(and(eq(clinicAccess.userId, userId), eq(clinicAccess.clinicId, clinicId), isNull(clinics.closedAt)));
  return row?.role ?? null;
}

/**
 * Adds or changes one person's role, for the member CLI and the demo seed. Owner connection.
 * An owner is account-wide (every location of the business); any other role is given at
 * the locations named, or at every location of the business when none are.
 */
export async function addMembership(db: Database, orgId: string, userId: string, role: StaffRole, approvesRefills?: boolean, clinicIds?: string[]) {
  if (role === 'owner') {
    await db.insert(memberships).values({ id: crypto.randomUUID(), organizationId: orgId, userId, role, approvesRefills: !!approvesRefills })
      .onConflictDoUpdate({ target: [memberships.organizationId, memberships.userId], set: { role, ...(approvesRefills === undefined ? {} : { approvesRefills }) } });
    await db.delete(clinicMemberships).where(and(eq(clinicMemberships.userId, userId), inArray(clinicMemberships.clinicId, db.select({ id: clinics.id }).from(clinics).where(eq(clinics.orgId, orgId)))));
    return;
  }
  const where = clinicIds?.length ? and(eq(clinics.orgId, orgId), inArray(clinics.id, clinicIds)) : eq(clinics.orgId, orgId);
  for (const { id: clinicId } of await db.select({ id: clinics.id }).from(clinics).where(where)) {
    await db.insert(clinicMemberships).values({ id: crypto.randomUUID(), clinicId, userId, role, approvesRefills: !!approvesRefills })
      .onConflictDoUpdate({ target: [clinicMemberships.clinicId, clinicMemberships.userId], set: { role, ...(approvesRefills === undefined ? {} : { approvesRefills }) } });
  }
  await db.delete(memberships).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)));
}

/** The organization a clinic belongs to. Owner connection; no PHI. */
export async function orgOfClinic(db: Database, clinicId: string): Promise<string | null> {
  const [row] = await db.select({ orgId: clinics.orgId }).from(clinics).where(eq(clinics.id, clinicId));
  return row?.orgId ?? null;
}

const actorOf = (userId: string) => `user:${userId}`;
/** Every save of the settings: one more on the version, and when and by whom. */
const bump = (userId: string) => ({ configVersion: sql`${clinics.configVersion} + 1`, configUpdatedAt: new Date(), configUpdatedBy: userId });

/** What a settings change hands back: the config to save with a result, or a result alone. */
export type SettingsChange<T> = { save: { name: string; timezone: string }; result: T } | { result: T };

/**
 * The newest requests one search of the queue reads and decrypts, for words in their details and notes, which have no
 * keys. A patient's or owner's name, a phone's digits and a request number are found by their keys past it; the keyed
 * candidates are read up to the same number.
 */
export const TASK_SEARCH_SCAN = 2000;
/** The newest calls whose numbers a search by a few digits decrypts and compares, when ATTENDRA_SEARCH_SCAN turns the old scan back on for this release. */
export const CALL_NUMBER_SCAN = 5000;
/** A patient shown again in a search by the same person within this many minutes is covered by the result row already written. */
export const SEARCH_RESULT_WINDOW_MINUTES = 5;
const TASK_LABELS: Record<string, string> = { refill: 'refill prescription', callback: 'callback call back', voicemail: 'voicemail message', review: 'review new patient check' };
const fold = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * A request matches when every word typed is found in its number ("R-1042" or "1042"), its patient's or owner's name,
 * its phone numbers, its details, its notes or its type; digits match inside phone numbers.
 */
export function taskMatches(q: string, t: { number?: number; type: string; patientName: string; details: string[]; owner?: string | null; phone?: string | null; notes?: string[] }): boolean {
  const hay = fold([t.patientName, t.owner ?? '', TASK_LABELS[t.type] ?? t.type, ...t.details, ...(t.notes ?? [])].join(' '));
  const digits = [hay, t.phone ?? ''].join(' ').replace(/\D/g, '');
  return fold(q).split(/\s+/).filter(Boolean).every((w) => {
    const asNumber = /^r-?(\d+)$/.exec(w);
    if (asNumber) return t.number === Number(asNumber[1]);
    const typed = w.replace(/\D/g, '');
    if (/^[\d()+.-]+$/.test(w) && typed) return t.number === Number(typed) || digits.includes(typed);
    return hay.includes(w);
  });
}

/**
 * One row per patient a search showed, in the search's transaction (docs/hipaa.md: who saw which patient in search
 * results). The query itself is never written. With `fold` (search as you type), a patient this person was already
 * shown within SEARCH_RESULT_WINDOW_MINUTES is covered by that row, the way task.viewed folds a refresh: typing
 * "m", "ma", "mar" shows mostly the same patients three times and records each of them once. A record opened is
 * audited by its own view, never folded here.
 */
export async function auditResults(tx: Tx, clinicId: string, userId: string, patientIds: string[], opts: { fold?: boolean } = {}) {
  let unique = [...new Set(patientIds)];
  if (opts.fold && unique.length) {
    const seen = new Set((await tx.select({ id: auditLogs.entityId }).from(auditLogs).where(and(
      eq(auditLogs.clinicId, clinicId), eq(auditLogs.actor, actorOf(userId)), eq(auditLogs.action, 'patient.search.result'), inArray(auditLogs.entityId, unique),
      sql`${auditLogs.at} > now() - make_interval(mins => ${SEARCH_RESULT_WINDOW_MINUTES})`,
    ))).map((r) => r.id));
    unique = unique.filter((id) => !seen.has(id));
  }
  if (unique.length) await tx.insert(auditLogs).values(unique.map((id) => ({ clinicId, actor: actorOf(userId), action: 'patient.search.result', entity: 'patient', entityId: id })));
}

/**
 * What the staff dashboard reads and changes. Every method runs as the application
 * role inside one clinic's scope, and every read of patient data writes an audit
 * row in the same transaction, so a view that failed to audit also failed to show.
 */
/** A staff member's own number at this location, for a take-over. Owner connection: memberships are not clinic rows. */
export async function transferNumber(db: Database, userId: string, clinicId: string): Promise<string | null> {
  const [row] = await db.select({ n: clinicAccess.transferNumber }).from(clinicAccess)
    .where(and(eq(clinicAccess.userId, userId), eq(clinicAccess.clinicId, clinicId)));
  return row?.n ?? null;
}

/** Whether this person may approve or decline a refill at this clinic: marked on the Team page. Owner connection. */
export async function approvesRefills(db: Database, userId: string, clinicId: string): Promise<boolean> {
  const [row] = await db.select({ ok: clinicAccess.approvesRefills }).from(clinicAccess)
    .where(and(eq(clinicAccess.userId, userId), eq(clinicAccess.clinicId, clinicId)));
  return !!row?.ok;
}

/**
 * Sets or clears it, audited in the clinic: a take-over rings this number, so a change to it is a change to where calls can go.
 * An owner's number is theirs at every location of the business; anyone else's is per location.
 */
export async function setTransferNumber(db: Database, userId: string, clinicId: string, number: string | null): Promise<boolean> {
  const org = await orgOfClinic(db, clinicId);
  if (!org) return false;
  let rows = await db.update(memberships).set({ transferNumber: number })
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, org))).returning({ id: memberships.id });
  if (!rows.length) {
    rows = await db.update(clinicMemberships).set({ transferNumber: number })
      .where(and(eq(clinicMemberships.userId, userId), eq(clinicMemberships.clinicId, clinicId))).returning({ id: clinicMemberships.id });
  }
  if (!rows.length) return false;
  await withClinic(db, clinicId, (tx) => tx.insert(auditLogs).values({
    clinicId, actor: actorOf(userId), action: number ? 'member.transfer_number.set' : 'member.transfer_number.cleared', entity: 'member', entityId: userId,
  }));
  return true;
}

/** Rolls back a live action's audit row when the action did not happen. */
class NotKept extends Error {}

export class FrontDeskRepository {
  /** `scan`: the Calls search by a few digits also decrypts the numbers of the newest CALL_NUMBER_SCAN calls, as before v0.10 (ATTENDRA_SEARCH_SCAN). */
  constructor(private readonly db: Database, private readonly cipher: PhiCipher, private readonly opts: { scan?: boolean } = {}) {}

  /**
   * The call list. Without `names` it carries no patient data: times, outcome, flags
   * and which tools ran. With `names` (roles that may read calls) it adds the name of
   * the patient the agent verified, and records the view: once per 5 minutes for the
   * list a screen refreshes, every time for a search. Pages on (started_at, id), with
   * the cursor keeping Postgres's full precision, so two calls that start in the same
   * instant are neither skipped nor repeated.
   */
  async listCalls(clinicId: string, opts: {
    before?: { startedAt: string; id: string }; limit: number;
    from?: Date; to?: Date; outcome?: string; channel?: 'phone' | 'web'; emergency?: boolean; needsReview?: boolean;
    /** A search: calls with one of these verified patients, or one of these ids (found by number or request). None of either is no match. */
    match?: { patientIds: string[]; callIds: string[] };
    /** Calls where a tool was refused with this code, for the quality page's links. */
    refusal?: string;
    names?: { userId: string; audit: 'list' | 'search'; matches?: number };
  }) {
    return withClinic(this.db, clinicId, async (tx) => {
      if (opts.match && !opts.match.patientIds.length && !opts.match.callIds.length) {
        if (opts.names?.audit === 'search') await tx.insert(auditLogs).values({ clinicId, actor: actorOf(opts.names.userId), action: 'calls.searched', entity: 'call', entityId: 'matches:0' });
        return [];
      }
      const rows = await tx.select({
        id: calls.id, startedAt: calls.startedAt, cursor: sql<string>`${calls.startedAt}::text`, endedAt: calls.endedAt, outcome: calls.outcome,
        emergency: calls.emergencyFlag, emergencyResult: calls.emergencyResult, closeReason: calls.closeReason, voiceSeconds: calls.voiceSeconds, channel: calls.channel, patientId: calls.patientId,
        firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc, fromEnc: calls.fromEnc, calledAsLast4: calls.calledAsLast4,
        // each step once, in the order the call took them; a confirmation says how it ended.
        // A confirm with nothing pending changed nothing and is left out here; the call page still shows it.
        tools: sql<string[]>`coalesce((select array_agg(s.step order by s.first) from (
          select case when a.tool <> 'commit_pending' then a.tool
            when a.result->>'error' = 'no_clear_yes' then 'commit_pending:no_clear_yes'
            when a.result->>'error' is not null then 'commit_pending:refused'
            when (a.result->>'cancelled')::boolean then 'commit_pending:cancelled'
            when (a.result->>'booked')::boolean then case when ${calls.outcome} = 'rescheduled' then 'commit_pending:rescheduled' else 'commit_pending:booked' end
            else 'commit_pending' end as step, min(a.id) as first
          from call_actions a where a.clinic_id = ${calls.clinicId} and a.call_id = ${calls.id}
            and a.result->>'error' is distinct from 'nothing_pending' group by 1) s), '{}')`,
        verified: sql<boolean>`coalesce(bool_or((${callActions.result}->>'verified')::boolean), false)`,
        // the number's first call to the clinic: many short first calls in a row say the number is being spoofed elsewhere
        firstCall: sql<boolean>`${calls.fromHash} is not null and not exists (select 1 from calls e where e.clinic_id = ${calls.clinicId} and e.from_hash = ${calls.fromHash} and e.started_at < ${calls.startedAt})`,
        // the summary's codes only; its text is PHI and stays on the call page
        intent: callSummaries.intent, sentiment: callSummaries.sentiment,
        needsReview: sql<boolean>`coalesce(${callSummaries.needsReview} and ${callSummaries.reviewedAt} is null, false)`,
      }).from(calls).leftJoin(callActions, eq(callActions.callId, calls.id)).leftJoin(patients, eq(patients.id, calls.patientId))
        .leftJoin(callSummaries, eq(callSummaries.callId, calls.id))
        .where(and(eq(calls.clinicId, clinicId),
          opts.before ? sql`(${calls.startedAt}, ${calls.id}) < (${opts.before.startedAt}::timestamptz, ${opts.before.id}::uuid)` : undefined,
          opts.from ? sql`${calls.startedAt} >= ${opts.from}` : undefined,
          opts.to ? sql`${calls.startedAt} < ${opts.to}` : undefined,
          opts.outcome ? eq(calls.outcome, opts.outcome) : undefined,
          opts.channel ? eq(calls.channel, opts.channel) : undefined,
          opts.emergency !== undefined ? eq(calls.emergencyFlag, opts.emergency) : undefined,
          opts.match ? or(opts.match.patientIds.length ? inArray(calls.patientId, opts.match.patientIds) : undefined, opts.match.callIds.length ? inArray(calls.id, opts.match.callIds) : undefined) : undefined,
          opts.needsReview ? sql`${callSummaries.needsReview} and ${callSummaries.reviewedAt} is null` : undefined,
          opts.refusal ? sql`exists (select 1 from call_actions r where r.call_id = ${calls.id} and r.result->>'error' = ${opts.refusal})` : undefined))
        .groupBy(calls.id, patients.id, callSummaries.callId).orderBy(desc(calls.startedAt), desc(calls.id)).limit(opts.limit);
      const shown = rows.flatMap((r) => (r.firstNameEnc && r.patientId ? [r.patientId] : []));
      if (opts.names?.audit === 'search') {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(opts.names.userId), action: 'calls.searched', entity: 'call', entityId: `matches:${rows.length}` });
        await auditResults(tx, clinicId, opts.names.userId, shown, { fold: true });
      } else if (opts.names && shown.length) {
        // everything that changes what the list shows is in the key: filters, page, and who is on it
        const key = [
          `from=${opts.from?.toISOString() ?? ''}`, `to=${opts.to?.toISOString() ?? ''}`, `outcome=${opts.outcome ?? ''}`, `channel=${opts.channel ?? ''}`,
          `emergency=${opts.emergency ?? ''}`, `review=${opts.needsReview ?? ''}`, `refusal=${opts.refusal ?? ''}`, `before=${opts.before ? `${opts.before.startedAt}|${opts.before.id}` : ''}`, `limit=${opts.limit}`, patientSetKey(shown),
        ].join(';');
        await recordView(tx, { clinicId, actor: actorOf(opts.names.userId), action: 'calls.listed', entity: 'call', entityId: key }, 5);
      }
      const ctx = (col: string) => phiContext(clinicId, col);
      return rows.map(({ firstNameEnc, lastNameEnc, fromEnc, calledAsLast4, ...r }) => ({
        ...r, voiceSeconds: r.voiceSeconds === null ? null : Number(r.voiceSeconds),
        // the number they called from, for the same roles as the name: staff call back from the list
        callerNumber: opts.names && fromEnc ? this.cipher.decrypt(fromEnc, ctx('calls.from')) : null,
        // a browser test call started as a number: its last four digits, for the same roles
        calledAsLast4: opts.names ? calledAsLast4 : null,
        patientName: opts.names && firstNameEnc && lastNameEnc
          ? `${this.cipher.decrypt(firstNameEnc, ctx('patients.first_name'))} ${this.cipher.decrypt(lastNameEnc, ctx('patients.last_name'))}` : null,
      }));
    });
  }

  /**
   * The calls from a phone number, for the Calls search. A whole number (ten digits or more)
   * is found by its keyed hash, like the number of a call coming in; fewer digits (the last
   * four, an area code) by the keyed hash of that run of digits (call_search_keys, migration
   * 0049), so no number is decrypted to find them. A call from before 0049 has no keys until
   * the rehash has run. Ids only; the search that shows them writes the audit rows.
   */
  async callIdsByNumber(clinicId: string, digits: string): Promise<string[]> {
    return withClinic(this.db, clinicId, async (tx) => {
      if (digits.length > PHONE_PART_DIGITS) {
        return (await tx.select({ id: calls.id }).from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.fromHash, this.cipher.hash(callerKey(clinicId, digits)))))).map((c) => c.id);
      }
      const keyed = (await tx.select({ id: callSearchKeys.callId }).from(callSearchKeys)
        .where(and(eq(callSearchKeys.clinicId, clinicId), eq(callSearchKeys.key, searchHash(this.cipher, callerPartKey(clinicId, digits)))))).map((c) => c.id);
      if (!this.opts.scan) return keyed;
      // the way back for one release (ATTENDRA_SEARCH_SCAN): the numbers of the newest calls decrypted and compared, as before
      const rows = await tx.select({ id: calls.id, fromEnc: calls.fromEnc }).from(calls)
        .where(and(eq(calls.clinicId, clinicId), isNotNull(calls.fromEnc))).orderBy(desc(calls.startedAt), desc(calls.id)).limit(CALL_NUMBER_SCAN);
      const ctx = phiContext(clinicId, 'calls.from');
      return [...new Set([...keyed, ...rows.filter((r) => phoneMatch(digits, this.cipher.decrypt(r.fromEnc!, ctx)) !== null).map((r) => r.id)])];
    });
  }

  /** The calls whose requests carry this number (tasks.number, migration 0041). */
  async callIdsByRequestNumber(clinicId: string, number: number): Promise<string[]> {
    return withClinic(this.db, clinicId, async (tx) =>
      (await tx.select({ id: tasks.callId }).from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.number, number), isNotNull(tasks.callId)))).map((t) => t.id!));
  }

  /**
   * A staff member starts watching a live call. Its captions are PHI, so the watch is
   * audited once, as it starts; a reconnect to the same stream is the same watch.
   * False when the call is not this clinic's.
   */
  async watchLive(clinicId: string, callId: string, userId: string, audit: boolean): Promise<boolean> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [call] = await tx.select({ id: calls.id }).from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.id, callId)));
      if (!call) return false;
      // every stream opened is a watch, whatever the browser says it saw before; one row per person and call per five minutes
      if (audit) await recordView(tx, { clinicId, actor: actorOf(userId), action: 'call.live.watched', entity: 'call', entityId: callId, callId }, 5);
      return true;
    });
  }

  /**
   * A staff action on a live call, audited under the person who took it. Counts only:
   * a coaching note's length, never its words. The audit row is written first, in a
   * transaction, and `run` (the voice action) happens only once it is in: an action
   * whose row cannot be written never runs. When `keep` says the action did not
   * happen (someone else had the call) or was a repeat of the same click, the row is
   * rolled back, so the log holds the actions that happened, once each.
   */
  async auditedLiveAction<T>(clinicId: string, callId: string, userId: string, action: 'call.coached' | 'call.taken_over' | 'call.ended_by_staff',
    counts: Record<string, number> | undefined, run: () => Promise<T>, keep: (r: T) => boolean): Promise<T> {
    let result: { r: T } | null = null;
    try {
      return await withClinic(this.db, clinicId, async (tx) => {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action, entity: 'call', entityId: callId, callId, counts: counts ?? null });
        result = { r: await run() };
        if (!keep(result.r)) throw new NotKept();
        return result.r;
      });
    } catch (err) {
      if (err instanceof NotKept && result) return (result as { r: T }).r;
      throw err;
    }
  }

  /** The live call list with verified callers' short names, recorded once per five minutes for the same calls. */
  async recordLiveList(clinicId: string, userId: string, callIds: string[]) {
    if (!callIds.length) return;
    await withClinic(this.db, clinicId, (tx) => recordView(tx, { clinicId, actor: actorOf(userId), action: 'calls.live.listed', entity: 'call', entityId: patientSetKey(callIds) }, 5));
  }

  /** One call with its transcript. Reading the transcript is a PHI access. */
  async getCall(clinicId: string, callId: string, userId: string) {
    return withClinic(this.db, clinicId, async (tx) => {
      const [call] = await tx.select().from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.id, callId)));
      if (!call) return null;
      const segments = await tx.select().from(callSegments).where(eq(callSegments.callId, callId)).orderBy(callSegments.startMs, callSegments.id);
      const actions = await tx.select().from(callActions).where(eq(callActions.callId, callId)).orderBy(callActions.id);
      const callTasks = await tx.select({ id: tasks.id, number: tasks.number, type: tasks.type, status: tasks.status }).from(tasks).where(eq(tasks.callId, callId));
      const [summary] = await tx.select().from(callSummaries).where(and(eq(callSummaries.clinicId, clinicId), eq(callSummaries.callId, callId)));
      // what the call booked or cancelled, so the call page can link to it on the schedule
      const changed = await tx.select({ id: appointments.id, startsAt: appointments.startsAt, providerId: appointments.providerId, visitTypeId: appointments.visitTypeId,
        status: appointments.status, createdByCallId: appointments.createdByCallId, createdAt: appointments.createdAt, updatedAt: appointments.updatedAt }).from(appointments)
        .where(and(eq(appointments.clinicId, clinicId), or(eq(appointments.createdByCallId, callId), eq(appointments.cancelledByCallId, callId))))
        .orderBy(appointments.startsAt);
      // the call page refreshes while a summary is written: one row per person and call per five minutes
      await recordView(tx, { clinicId, actor: actorOf(userId), action: 'call.transcript.viewed', entity: 'call', entityId: callId, callId }, 5);
      // who the caller was, when the agent verified them: part of the same view
      const [caller] = call.patientId
        ? await tx.select({ id: patients.id, firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, call.patientId)))
        : [];
      const ctx = phiContext(clinicId, 'call_segments.text');
      return {
        id: call.id, startedAt: call.startedAt, endedAt: call.endedAt, outcome: call.outcome, emergency: call.emergencyFlag, emergencyResult: call.emergencyResult,
        closeReason: call.closeReason, voiceSeconds: call.voiceSeconds === null ? null : Number(call.voiceSeconds), channel: call.channel,
        callerNumber: call.fromEnc ? this.cipher.decrypt(call.fromEnc, phiContext(clinicId, 'calls.from')) : null,
        calledAsLast4: call.calledAsLast4,
        patient: caller ? {
          id: caller.id,
          name: `${this.cipher.decrypt(caller.firstNameEnc, phiContext(clinicId, 'patients.first_name'))} ${this.cipher.decrypt(caller.lastNameEnc, phiContext(clinicId, 'patients.last_name'))}`,
        } : null,
        transcript: segments.map((s) => ({ speaker: s.speaker, text: this.cipher.decrypt(s.textEnc, ctx), startMs: s.startMs, endMs: s.endMs })),
        actions: actions.map((a) => ({ tool: a.tool, argumentNames: a.argsRedacted as string[], result: a.result as Record<string, unknown>, revision: a.taskRevision, at: a.createdAt })),
        tasks: callTasks,
        // read in the same audited view as the transcript it summarises
        summary: summary ? decryptSummary(this.cipher, clinicId, summary) : null,
        appointments: changed.map((a) => ({
          id: a.id, startsAt: a.startsAt, providerId: a.providerId, visitTypeId: a.visitTypeId, status: a.status,
          change: a.createdByCallId === callId ? 'booked' as const : 'cancelled' as const,
          createdAt: a.createdAt, updatedAt: a.updatedAt,
          // still booked, but changed after the call made it: the front desk moved it
          moved: a.createdByCallId === callId && a.status === 'booked' && a.updatedAt.getTime() - a.createdAt.getTime() > 1000,
        })),
      };
    });
  }

  /**
   * The queue with no patient in it, for a viewer: number, type, state, age, who has it and
   * when it is due. Details, notes, names and numbers are never read, so nothing is audited.
   */
  async listTasksWithoutNames(clinicId: string, opts: { status: 'open' | 'done'; limit: number; type?: TaskType }) {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select().from(tasks)
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.status, opts.status), opts.type ? eq(tasks.type, opts.type) : undefined))
        .orderBy(...(opts.status === 'open' ? [desc(tasks.urgent), desc(tasks.createdAt)] : [desc(tasks.doneAt)]), desc(tasks.id))
        .limit(opts.limit);
      return rows.map((task) => ({
        id: task.id, number: task.number, type: task.type, status: task.status, callId: null, patientId: null, createdAt: task.createdAt,
        assigneeUserId: task.assigneeUserId, assignedByUserId: task.assignedByUserId, createdByUserId: task.createdByUserId, claimedAt: task.claimedAt, doneAt: task.doneAt, doneByUserId: task.doneByUserId, outcome: task.outcome,
        urgent: task.urgent, origin: task.origin, dueOn: task.dueOn, patientName: null, details: {} as Record<string, string>, custom: {} as Record<string, string>, followUp: null,
        notes: [] as { id: number; authorUserId: string; at: Date; body: string }[],
      }));
    });
  }

  /**
   * The queue with its details and notes decrypted; one audit row per task shown.
   * Filters run in the database, so a task that is not shown is not read or audited.
   * A search (`q`) writes one tasks.searched row with how many matched, never what was typed.
   */
  /** `viewer` is the staff member reading, or the API key an MCP client reads with; the task.viewed rows are theirs. */
  async listTasks(clinicId: string, opts: { status: 'open' | 'done'; limit: number; type?: TaskType; assignee?: { userId: string } | 'unassigned'; q?: string; from?: Date; to?: Date }, viewer: string | { apiKeyId: string }) {
    return withClinic(this.db, clinicId, async (tx) => {
      const filters = and(eq(tasks.clinicId, clinicId), eq(tasks.status, opts.status), opts.type ? eq(tasks.type, opts.type) : undefined,
        opts.assignee === 'unassigned' ? isNull(tasks.assigneeUserId) : opts.assignee ? eq(tasks.assigneeUserId, opts.assignee.userId) : undefined,
        opts.from ? sql`${tasks.createdAt} >= ${opts.from}` : undefined, opts.to ? lt(tasks.createdAt, opts.to) : undefined);
      const read = (where: SQL | undefined, limit: number) => tx.select({ task: tasks, firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc, guardianNameEnc: patients.guardianNameEnc, phoneEnc: patients.phoneEnc, summary: callSummaries })
        .from(tasks).leftJoin(patients, eq(patients.id, tasks.patientId)).leftJoin(callSummaries, eq(callSummaries.callId, tasks.callId))
        .where(where)
        // the newest first: what just came in is what the front desk looks for
        // urgent ones lead the open queue
        .orderBy(...(opts.status === 'open' ? [desc(tasks.urgent), desc(tasks.createdAt)] : [desc(tasks.doneAt)]), desc(tasks.id))
        .limit(limit);
      if (!opts.q) return this.taskViews(tx, clinicId, await read(filters, opts.limit), viewer);
      // a search reads the newest TASK_SEARCH_SCAN and decrypts them, for words in the details and notes, which have no keys
      // (decision 7); a name, a phone's digits, the type or the number are found past that by their keys
      const keyed = this.taskKeys(tx, clinicId, opts.q);
      const rows = [...new Map([...await read(filters, Math.max(opts.limit, TASK_SEARCH_SCAN)), ...(keyed ? await read(and(filters, keyed), TASK_SEARCH_SCAN) : [])].map((r) => [r.task.id, r])).values()]
        .sort(opts.status === 'open'
          ? (a, b) => Number(b.task.urgent) - Number(a.task.urgent) || b.task.createdAt.getTime() - a.task.createdAt.getTime() || (b.task.id > a.task.id ? 1 : -1)
          : (a, b) => (b.task.doneAt?.getTime() ?? Infinity) - (a.task.doneAt?.getTime() ?? Infinity) || (b.task.id > a.task.id ? 1 : -1));
      const ctxOf = (col: string) => phiContext(clinicId, col);
      // a search also reads the notes of the rows it reads: what the team wrote on a request is something they search by
      const scannedNotes = rows.length
        ? await tx.select({ taskId: taskNotes.taskId, bodyEnc: taskNotes.bodyEnc }).from(taskNotes).where(and(eq(taskNotes.clinicId, clinicId), inArray(taskNotes.taskId, rows.map((r) => r.task.id))))
        : [];
      const matching = rows.filter((r) => taskMatches(opts.q!, {
        number: r.task.number,
        type: r.task.type,
        patientName: r.firstNameEnc && r.lastNameEnc ? `${this.cipher.decrypt(r.firstNameEnc, ctxOf('patients.first_name'))} ${this.cipher.decrypt(r.lastNameEnc, ctxOf('patients.last_name'))}` : '',
        owner: r.guardianNameEnc ? this.cipher.decrypt(r.guardianNameEnc, ctxOf('patients.guardian_name')) : null,
        phone: r.phoneEnc ? this.cipher.decrypt(r.phoneEnc, ctxOf('patients.phone')) : null,
        details: Object.values(JSON.parse(this.cipher.decrypt(r.task.detailsEnc, ctxOf('tasks.details'))) as Record<string, string>),
        notes: scannedNotes.filter((n) => n.taskId === r.task.id).map((n) => this.cipher.decrypt(n.bodyEnc, ctxOf('task_notes.body'))),
      }));
      // one row per search, with how many matched; each request shown is its own task.viewed below
      const actor = typeof viewer === 'string' ? actorOf(viewer) : `api_key:${viewer.apiKeyId}`;
      await tx.insert(auditLogs).values({ clinicId, actor, action: 'tasks.searched', entity: 'task', entityId: `matches:${matching.length}` });
      return this.taskViews(tx, clinicId, matching.slice(0, opts.limit), viewer);
    });
  }

  /**
   * The requests a search can reach by keys, whatever their age: every word typed must be the request's number, part
   * of its type, the start or the sound of a word of its patient's or owner's name, or digits of the patient's phone
   * (the patient's search keys, searchKeyHashes). Null when a word can be none of these: it is looked for in the details
   * and notes of the newest requests only. What the keys find is still matched by taskMatches on the decrypted text.
   */
  private taskKeys(tx: Tx, clinicId: string, q: string): SQL | null {
    const has = (keys: string[]) => inArray(tasks.patientId, patientsWithKey(tx, this.cipher, clinicId, keys));
    const each = fold(q).split(/\s+/).filter(Boolean).map((w): SQL | undefined => {
      const asNumber = /^r-?(\d{1,9})$/.exec(w);
      if (asNumber) return eq(tasks.number, Number(asNumber[1]));
      const typed = w.replace(/\D/g, '');
      if (/^[\d()+.-]+$/.test(w) && typed) {
        return or(typed.length <= PHONE_PART_DIGITS ? eq(tasks.number, Number(typed)) : undefined,
          typed.length > PHONE_PART_DIGITS ? eq(patients.phoneHash, this.cipher.hash(phoneKey(clinicId, typed))) : has([phonePartKey(clinicId, typed)]));
      }
      const types = TASK_TYPES.filter((t) => (TASK_LABELS[t] ?? t).includes(w));
      const name = normalizeName(w).split(' ').filter(Boolean);
      return or(types.length ? inArray(tasks.type, types) : undefined, name.length ? and(...name.map((n) => has(nameWordKeys(clinicId, n)))) : undefined);
    });
    return each.every(Boolean) ? and(...each as SQL[])! : null;
  }

  /** Requests as staff see them: details and notes decrypted, one audit row per request shown. */
  private async taskViews(tx: Tx, clinicId: string, rows: { task: typeof tasks.$inferSelect; firstNameEnc: string | null; lastNameEnc: string | null; guardianNameEnc?: string | null; phoneEnc?: string | null; summary: typeof callSummaries.$inferSelect | null }[], viewer: string | { apiKeyId: string }) {
    const actor = typeof viewer === 'string' ? actorOf(viewer) : `api_key:${viewer.apiKeyId}`;
    const notes = rows.length
      ? await tx.select().from(taskNotes).where(and(eq(taskNotes.clinicId, clinicId), inArray(taskNotes.taskId, rows.map((r) => r.task.id)))).orderBy(taskNotes.createdAt, taskNotes.id)
      : [];
    // the Requests page reads again on every change to a request (and every 2 minutes): one row per person and request per five minutes
    for (const { task } of rows) await recordView(tx, { clinicId, actor, action: 'task.viewed', entity: 'task', entityId: task.id, callId: task.callId }, 5);
    const ctx = (col: string) => phiContext(clinicId, col);
    return rows.map(({ task, firstNameEnc, lastNameEnc, summary }) => ({
      id: task.id, number: task.number, type: task.type, status: task.status, callId: task.callId, patientId: task.patientId, createdAt: task.createdAt,
      assigneeUserId: task.assigneeUserId, assignedByUserId: task.assignedByUserId, createdByUserId: task.createdByUserId, claimedAt: task.claimedAt, doneAt: task.doneAt, doneByUserId: task.doneByUserId, outcome: task.outcome,
      urgent: task.urgent, origin: task.origin, dueOn: task.dueOn,
      patientName: firstNameEnc && lastNameEnc
        ? `${this.cipher.decrypt(firstNameEnc, ctx('patients.first_name'))} ${this.cipher.decrypt(lastNameEnc, ctx('patients.last_name'))}`
        : null,
      details: JSON.parse(this.cipher.decrypt(task.detailsEnc, ctx('tasks.details'))) as Record<string, string>,
      custom: task.customEnc ? JSON.parse(this.cipher.decrypt(task.customEnc, ctx('tasks.custom'))) as Record<string, string> : {},
      // what the call's summary suggests staff do, for a request the assistant created
      followUp: summary ? decryptSummary(this.cipher, clinicId, summary).followUp : null,
      notes: notes.filter((n) => n.taskId === task.id).map((n) => ({ id: n.id, authorUserId: n.authorUserId, at: n.createdAt, body: this.cipher.decrypt(n.bodyEnc, ctx('task_notes.body')) })),
    }));
  }

  /** The clinic's own details on a request: the whole set, encrypted, audited without the values. */
  async setTaskFields(clinicId: string, taskId: string, values: Record<string, string>, userId: string): Promise<'saved' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const customEnc = Object.keys(values).length ? this.cipher.encrypt(JSON.stringify(values), phiContext(clinicId, 'tasks.custom')) : null;
      const [row] = await tx.update(tasks).set({ customEnc }).where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId))).returning({ id: tasks.id, callId: tasks.callId });
      if (!row) return 'not_found';
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'task.fields.updated', entity: 'task', entityId: taskId, callId: row.callId });
      return 'saved';
    });
  }

  /** Adds an internal note to a request. Notes are never edited or removed. */
  async addTaskNote(clinicId: string, taskId: string, userId: string, body: string): Promise<'added' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [task] = await tx.select({ id: tasks.id, callId: tasks.callId }).from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId)));
      if (!task) return 'not_found';
      await tx.insert(taskNotes).values({ clinicId, taskId, authorUserId: userId, bodyEnc: this.cipher.encrypt(body, phiContext(clinicId, 'task_notes.body')) });
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'task.note.added', entity: 'task', entityId: taskId, callId: task.callId });
      return 'added';
    });
  }

  /** Marks an open request urgent or not, and sets or clears the day it is due. What is left out stays as it was. Audited. */
  async planTask(clinicId: string, taskId: string, plan: { urgent?: boolean; dueOn?: string | null }, userId: string): Promise<'planned' | 'taken' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const set = { ...(plan.urgent !== undefined ? { urgent: plan.urgent } : {}), ...(plan.dueOn !== undefined ? { dueOn: plan.dueOn } : {}) };
      const updated = Object.keys(set).length
        ? await tx.update(tasks).set(set).where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId), eq(tasks.status, 'open'))).returning({ id: tasks.id, callId: tasks.callId })
        : await tx.select({ id: tasks.id, callId: tasks.callId }).from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId), eq(tasks.status, 'open')));
      if (updated.length) {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'task.planned', entity: 'task', entityId: taskId, callId: updated[0]!.callId });
        return 'planned';
      }
      const [exists] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId)));
      return exists ? 'taken' : 'not_found';
    });
  }

  /** Gives an open request to a teammate, whoever holds it now. Owners and managers only; the caller checks the teammate's role. */
  async assignTask(clinicId: string, taskId: string, assigneeId: string, byUserId: string): Promise<'assigned' | 'taken' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const updated = await tx.update(tasks).set({ assigneeUserId: assigneeId, assignedByUserId: byUserId, claimedAt: new Date() })
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId), eq(tasks.status, 'open'))).returning({ id: tasks.id, number: tasks.number });
      if (updated.length) {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(byUserId), action: 'task.assigned', entity: 'task', entityId: taskId, counts: { number: updated[0]!.number } });
        return 'assigned';
      }
      const [exists] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId)));
      return exists ? 'taken' : 'not_found';
    });
  }

  /** How many tasks are open, for the badge in the menu. No patient data, so no audit row. */
  async openTaskCount(clinicId: string): Promise<number> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.status, 'open')));
      return row?.n ?? 0;
    });
  }

  /**
   * Gives a claimed task back to the queue. The holder can always release it; with
   * override (owners and admins), anyone's, for when the holder has gone home.
   */
  async releaseTask(clinicId: string, taskId: string, userId: string, override: boolean): Promise<'released' | 'taken' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const updated = await tx.update(tasks).set({ assigneeUserId: null, claimedAt: null })
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId), eq(tasks.status, 'open'),
          override ? sql`${tasks.assigneeUserId} is not null` : eq(tasks.assigneeUserId, userId)))
        .returning({ id: tasks.id, number: tasks.number });
      if (updated.length) {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: override ? 'task.released.override' : 'task.released', entity: 'task', entityId: taskId, counts: { number: updated[0]!.number } });
        return 'released';
      }
      const [exists] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId)));
      return exists ? 'taken' : 'not_found';
    });
  }

  /** Takes an open task. Fails if someone else already holds it, so two people never call the same patient back. */
  async claimTask(clinicId: string, taskId: string, userId: string): Promise<'claimed' | 'taken' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const updated = await tx.update(tasks).set({ assigneeUserId: userId, claimedAt: new Date() })
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId), eq(tasks.status, 'open'),
          or(isNull(tasks.assigneeUserId), eq(tasks.assigneeUserId, userId))))
        .returning({ id: tasks.id, number: tasks.number });
      if (updated.length) {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'task.claimed', entity: 'task', entityId: taskId, counts: { number: updated[0]!.number } });
        return 'claimed';
      }
      const [exists] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId)));
      return exists ? 'taken' : 'not_found';
    });
  }

  /** Closes a task, with what came of it. Anyone on staff can close an unclaimed task; a claimed one only by its holder. */
  async completeTask(clinicId: string, taskId: string, userId: string, outcome: TaskOutcome | null = null): Promise<'done' | 'taken' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const updated = await tx.update(tasks).set({ status: 'done', doneAt: new Date(), doneByUserId: userId, outcome })
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId), eq(tasks.status, 'open'),
          or(isNull(tasks.assigneeUserId), eq(tasks.assigneeUserId, userId))))
        .returning({ id: tasks.id, number: tasks.number, type: tasks.type, patientId: tasks.patientId, callId: tasks.callId });
      if (updated.length) {
        // an approval or a refusal of a refill is named in the log, with who made it
        const decision = updated[0]!.type === 'refill' && (outcome === 'refill_sent' || outcome === 'refill_ready' || outcome === 'refill_declined') ? `.${outcome}` : '';
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: `task.done${decision}`, entity: 'task', entityId: taskId, counts: { number: updated[0]!.number } });
        // checking a patient the assistant added makes them an ordinary patient
        const { type, patientId, callId } = updated[0]!;
        // getting back to the caller is the review the call was flagged for
        if (type === 'follow_up' && callId) {
          await tx.update(callSummaries).set({ reviewedAt: new Date(), reviewedByUserId: userId })
            .where(and(eq(callSummaries.callId, callId), isNull(callSummaries.reviewedAt)));
        }
        if (type === 'review' && outcome === 'details_confirmed' && patientId) {
          await tx.update(patients).set({ status: 'active' }).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)));
          await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'patient.confirmed', entity: 'patient', entityId: patientId });
        }
        return 'done';
      }
      const [exists] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId)));
      return exists ? 'taken' : 'not_found';
    });
  }

  /**
   * What the assistant did since `from`, for the home screen: the phone calls it
   * answered (browser tests are staff trying it out, so they are left out) and the
   * requests it took. Times, outcomes and durations only; no patient data.
   */
  async activity(clinicId: string, from: Date) {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select({ startedAt: calls.startedAt, outcome: calls.outcome, closeReason: calls.closeReason, voiceSeconds: calls.voiceSeconds, emergency: calls.emergencyFlag })
        .from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.channel, 'phone'), sql`${calls.startedAt} >= ${from}`));
      const requests = await tx.select({ createdAt: tasks.createdAt }).from(tasks)
        .innerJoin(calls, eq(calls.id, tasks.callId))
        .where(and(eq(tasks.clinicId, clinicId), eq(calls.channel, 'phone'), sql`${tasks.createdAt} >= ${from}`));
      return { calls: rows.map((r) => ({ ...r, voiceSeconds: r.voiceSeconds === null ? 0 : Number(r.voiceSeconds) })), requests: requests.map((r) => r.createdAt) };
    });
  }

  /**
   * Open requests nobody has claimed, newest first: type and age only, so the home
   * screen shows them without reading patient data. `total` counts them all, past the
   * first `limit`.
   */
  async waitingTasks(clinicId: string, limit = 20) {
    return withClinic(this.db, clinicId, async (tx) => {
      const waiting = and(eq(tasks.clinicId, clinicId), eq(tasks.status, 'open'), isNull(tasks.assigneeUserId));
      // urgent ones first (a request taken during an emergency), as on the Requests page
      const rows = await tx.select({ id: tasks.id, number: tasks.number, type: tasks.type, createdAt: tasks.createdAt, callId: tasks.callId, urgent: tasks.urgent, origin: tasks.origin }).from(tasks)
        .where(waiting).orderBy(desc(tasks.urgent), desc(tasks.createdAt), desc(tasks.id)).limit(limit);
      const counts = await tx.select({ type: tasks.type, n: sql<number>`count(*)::int` }).from(tasks).where(waiting).groupBy(tasks.type);
      const byType = Object.fromEntries(counts.map((c) => [c.type, Number(c.n)]));
      return { tasks: rows, total: counts.reduce((n, c) => n + Number(c.n), 0), byType };
    });
  }

  /** Whether a record is this clinic's: an id only, no patient data, so no audit row. */
  async patientExists(clinicId: string, patientId: string): Promise<boolean> {
    return withClinic(this.db, clinicId, async (tx) => !!(await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)))).length);
  }

  /** Booked time in [from, to), for the open-slot search. No patient data, so no audit row. */
  async busy(clinicId: string, q: { from: Date; to: Date; except?: string }) {
    return withClinic(this.db, clinicId, (tx) => tx.select({ providerId: appointments.providerId, start: appointments.startsAt, end: appointments.endsAt, visitTypeId: appointments.visitTypeId })
      .from(appointments).where(and(eq(appointments.clinicId, clinicId), eq(appointments.status, 'booked'),
        lt(appointments.startsAt, q.to), sql`${appointments.endsAt} > ${q.from}`, q.except ? sql`${appointments.id} <> ${q.except}` : undefined)));
  }

  /**
   * Who a patient may be booked with: their date of birth and whether they are new, for
   * the open-slot search. Nothing of it leaves the API, so no audit row (opening the
   * patient to book them is audited already).
   */
  async bookingFit(clinicId: string, patientId: string): Promise<{ dob: string; isNew: boolean } | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [r] = await tx.select({ dobEnc: patients.dobEnc, status: patients.status }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, patientId)));
      return r ? { dob: this.cipher.decrypt(r.dobEnc, phiContext(clinicId, 'patients.dob')), isNew: r.status === 'new' } : null;
    });
  }

  async settings(clinicId: string): Promise<unknown | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select({ config: clinics.config }).from(clinics).where(eq(clinics.id, clinicId));
      return row?.config ?? null;
    });
  }

  /** The settings with their version: one more on every save, so a save made from an older copy can be refused. */
  async settingsVersioned(clinicId: string): Promise<{ config: unknown; version: number; updatedAt: Date | null; updatedBy: string | null } | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select({ config: clinics.config, version: clinics.configVersion, updatedAt: clinics.configUpdatedAt, updatedBy: clinics.configUpdatedBy })
        .from(clinics).where(eq(clinics.id, clinicId));
      return row ?? null;
    });
  }

  /**
   * Reads the clinic's settings, applies a change and saves it, with the row locked so
   * two people editing doctors at once cannot undo each other. `change` returns the
   * validated config to save, or a value to hand back without saving.
   */
  async updateSettings<T>(clinicId: string, userId: string, action: string, entityId: string,
    change: (current: unknown, tx: Tx) => SettingsChange<T> | Promise<SettingsChange<T>>): Promise<T | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select({ config: clinics.config }).from(clinics).where(eq(clinics.id, clinicId)).for('update');
      if (!row) return null;
      const out = await change(row.config, tx);
      if ('save' in out) {
        await tx.update(clinics).set({ name: out.save.name, timezone: out.save.timezone, config: out.save, ...bump(userId) }).where(eq(clinics.id, clinicId));
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action, entity: 'clinic', entityId });
      }
      return out.result;
    });
  }

  /** Booked visits still to come with a provider: a provider with any cannot be removed. Inside `updateSettings`, pass its transaction. */
  async upcomingForProvider(clinicId: string, providerId: string, now: Date, within?: Tx): Promise<number> {
    const count = async (tx: Tx) => {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(appointments)
        .where(and(eq(appointments.clinicId, clinicId), eq(appointments.providerId, providerId), eq(appointments.status, 'booked'), sql`${appointments.startsAt} >= ${now}`)) as [{ n: number }];
      return n;
    };
    return within ? count(within) : withClinic(this.db, clinicId, count);
  }

  /** Every visit with a provider, past or to come, in any state: a provider something still points at is kept in the settings. Inside `updateSettings`, pass its transaction. */
  async visitsWithProvider(clinicId: string, providerId: string, within?: Tx): Promise<number> {
    const count = async (tx: Tx) => {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(appointments)
        .where(and(eq(appointments.clinicId, clinicId), eq(appointments.providerId, providerId))) as [{ n: number }];
      return n;
    };
    return within ? count(within) : withClinic(this.db, clinicId, count);
  }

  /**
   * Saves a validated ClinicConfig. The caller checks that the id and phone numbers are
   * unchanged. With `expectedVersion`, it saves only over that version: someone else's
   * save in between is a conflict, and nothing is written.
   */
  async saveSettings(clinicId: string, config: { name: string; timezone: string }, userId: string, action = 'clinic.settings.updated', opts: { expectedVersion?: number } = {}):
    Promise<{ status: 'saved'; version: number } | { status: 'conflict' }> {
    return withClinic(this.db, clinicId, async (tx) => {
      const match = opts.expectedVersion === undefined ? eq(clinics.id, clinicId) : and(eq(clinics.id, clinicId), eq(clinics.configVersion, opts.expectedVersion));
      const [row] = await tx.update(clinics).set({ name: config.name, timezone: config.timezone, config, ...bump(userId) }).where(match).returning({ version: clinics.configVersion });
      if (!row) return { status: 'conflict' as const };
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action, entity: 'clinic', entityId: clinicId });
      return { status: 'saved' as const, version: row.version };
    });
  }

  /**
   * The texts about one call, request, pet or patient, or visit, newest first. Only
   * the last four digits of the number, and only when the text is about a patient
   * (the stored hash is one way). Listing a patient's texts is audited as a view.
   */
  async texts(clinicId: string, filter: { callId?: string; taskId?: string; patientId?: string; appointmentId?: string }, userId?: string) {
    return withClinic(this.db, clinicId, async (tx) => {
      const where = filter.callId ? eq(smsMessages.callId, filter.callId) : filter.taskId ? eq(smsMessages.taskId, filter.taskId)
        : filter.patientId ? eq(smsMessages.patientId, filter.patientId) : eq(smsMessages.appointmentId, filter.appointmentId ?? '');
      const rows = await tx.select().from(smsMessages).where(and(eq(smsMessages.clinicId, clinicId), where)).orderBy(desc(smsMessages.createdAt)).limit(20);
      let last4: string | null = null;
      if (filter.patientId) {
        const [p] = await tx.select({ phoneEnc: patients.phoneEnc }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, filter.patientId)));
        last4 = p?.phoneEnc ? this.cipher.decrypt(p.phoneEnc, phiContext(clinicId, 'patients.phone')).replace(/\D/g, '').slice(-4) : null;
        if (userId) await recordView(tx, { clinicId, actor: actorOf(userId), action: 'patient.texts.viewed', entity: 'patient', entityId: filter.patientId }, 5);
      }
      return rows.map((r) => ({
        id: r.id, template: r.template, kind: r.kind, status: r.status, failureReason: r.failureReason, errorCode: r.errorCode, language: r.language,
        callId: r.callId, createdAt: r.createdAt, sentAt: r.sentAt, deliveredAt: r.deliveredAt, consentAtMs: r.consentAtMs, toLast4: last4,
      }));
    });
  }

  /** Newest first. Pages by id, not time: one request can write several rows with the same timestamp. */
  async auditTrail(clinicId: string, opts: { beforeId?: number; limit: number; actions?: string[] }) {
    return withClinic(this.db, clinicId, (tx) => tx.select({
      id: auditLogs.id, at: auditLogs.at, actor: auditLogs.actor, action: auditLogs.action,
      entity: auditLogs.entity, entityId: auditLogs.entityId, callId: auditLogs.callId, counts: auditLogs.counts,
    }).from(auditLogs)
      .where(and(eq(auditLogs.clinicId, clinicId), opts.beforeId ? lt(auditLogs.id, opts.beforeId) : undefined,
        opts.actions?.length ? inArray(auditLogs.action, opts.actions) : undefined))
      .orderBy(desc(auditLogs.id)).limit(opts.limit));
  }
}
