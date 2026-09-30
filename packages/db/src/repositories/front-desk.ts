// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { memberships } from '../auth-schema';
import { type Database, type Tx, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { patientSetKey, recordView } from './audit';
import { appointments, auditLogs, callActions, calls, callSegments, callSummaries, clinics, patients, taskNotes, tasks } from '../schema';
import { decryptSummary } from './summaries';

export type StaffRole = 'owner' | 'admin' | 'staff' | 'viewer';
export type TaskOutcome = 'called_back' | 'left_message' | 'refill_sent' | 'not_needed';
type TaskType = 'callback' | 'refill' | 'voicemail' | 'review';

/**
 * Which clinics a signed-in person can open, and with which role. Runs as the owner
 * connection because it decides the tenant; everything after it runs inside
 * withClinic for the clinic it returns.
 */
export async function clinicsForUser(db: Database, userId: string) {
  return db.select({ clinicId: clinics.id, clinicName: clinics.name, timezone: clinics.timezone, orgId: clinics.orgId, role: memberships.role })
    .from(memberships).innerJoin(clinics, eq(clinics.orgId, memberships.organizationId))
    .where(eq(memberships.userId, userId)).orderBy(clinics.name);
}

export async function staffRole(db: Database, userId: string, clinicId: string): Promise<StaffRole | null> {
  const [row] = await db.select({ role: memberships.role }).from(memberships)
    .innerJoin(clinics, eq(clinics.orgId, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), eq(clinics.id, clinicId)));
  return row?.role ?? null;
}

/** Adds or changes one person's role in one organization. Owner connection; used by the member CLI and the demo seed. */
export async function addMembership(db: Database, orgId: string, userId: string, role: StaffRole) {
  await db.insert(memberships).values({ id: crypto.randomUUID(), organizationId: orgId, userId, role })
    .onConflictDoUpdate({ target: [memberships.organizationId, memberships.userId], set: { role } });
}

/** The organization a clinic belongs to. Owner connection; no PHI. */
export async function orgOfClinic(db: Database, clinicId: string): Promise<string | null> {
  const [row] = await db.select({ orgId: clinics.orgId }).from(clinics).where(eq(clinics.id, clinicId));
  return row?.orgId ?? null;
}

const actorOf = (userId: string) => `user:${userId}`;

/** One row per patient a search showed, in the search's transaction. The query itself is never written. */
export async function auditResults(tx: Tx, clinicId: string, userId: string, patientIds: string[]) {
  const unique = [...new Set(patientIds)];
  if (unique.length) await tx.insert(auditLogs).values(unique.map((id) => ({ clinicId, actor: actorOf(userId), action: 'patient.search.result', entity: 'patient', entityId: id })));
}

/**
 * What the staff dashboard reads and changes. Every method runs as the application
 * role inside one clinic's scope, and every read of patient data writes an audit
 * row in the same transaction, so a view that failed to audit also failed to show.
 */
/** A staff member's own number at the clinic's practice, for a take-over. Owner connection: memberships are not clinic rows. */
export async function transferNumber(db: Database, userId: string, clinicId: string): Promise<string | null> {
  const [row] = await db.select({ n: memberships.transferNumber }).from(memberships)
    .innerJoin(clinics, eq(clinics.orgId, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), eq(clinics.id, clinicId)));
  return row?.n ?? null;
}

/** Sets or clears it, audited in the clinic: a take-over rings this number, so a change to it is a change to where calls can go. */
export async function setTransferNumber(db: Database, userId: string, clinicId: string, number: string | null): Promise<boolean> {
  const org = await orgOfClinic(db, clinicId);
  if (!org) return false;
  const rows = await db.update(memberships).set({ transferNumber: number })
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, org))).returning({ id: memberships.id });
  if (!rows.length) return false;
  await withClinic(db, clinicId, (tx) => tx.insert(auditLogs).values({
    clinicId, actor: actorOf(userId), action: number ? 'member.transfer_number.set' : 'member.transfer_number.cleared', entity: 'member', entityId: userId,
  }));
  return true;
}

/** Rolls back a live action's audit row when the action did not happen. */
class NotKept extends Error {}

export class FrontDeskRepository {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher) {}

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
    from?: Date; to?: Date; outcome?: string; channel?: 'phone' | 'web'; emergency?: boolean; patientIds?: string[]; needsReview?: boolean;
    /** Calls where a tool was refused with this code, for the quality page's links. */
    refusal?: string;
    names?: { userId: string; audit: 'list' | 'search'; matches?: number };
  }) {
    return withClinic(this.db, clinicId, async (tx) => {
      if (opts.patientIds && !opts.patientIds.length) {
        if (opts.names?.audit === 'search') await tx.insert(auditLogs).values({ clinicId, actor: actorOf(opts.names.userId), action: 'calls.searched', entity: 'call', entityId: 'matches:0' });
        return [];
      }
      const rows = await tx.select({
        id: calls.id, startedAt: calls.startedAt, cursor: sql<string>`${calls.startedAt}::text`, endedAt: calls.endedAt, outcome: calls.outcome,
        emergency: calls.emergencyFlag, closeReason: calls.closeReason, voiceSeconds: calls.voiceSeconds, channel: calls.channel, patientId: calls.patientId,
        firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc,
        tools: sql<string[]>`coalesce(array_agg(distinct ${callActions.tool}) filter (where ${callActions.tool} is not null), '{}')`,
        verified: sql<boolean>`coalesce(bool_or((${callActions.result}->>'verified')::boolean), false)`,
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
          opts.patientIds ? inArray(calls.patientId, opts.patientIds) : undefined,
          opts.needsReview ? sql`${callSummaries.needsReview} and ${callSummaries.reviewedAt} is null` : undefined,
          opts.refusal ? sql`exists (select 1 from call_actions r where r.call_id = ${calls.id} and r.result->>'error' = ${opts.refusal})` : undefined))
        .groupBy(calls.id, patients.id, callSummaries.callId).orderBy(desc(calls.startedAt), desc(calls.id)).limit(opts.limit);
      const shown = rows.flatMap((r) => (r.firstNameEnc && r.patientId ? [r.patientId] : []));
      if (opts.names?.audit === 'search') {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(opts.names.userId), action: 'calls.searched', entity: 'call', entityId: `matches:${rows.length}` });
        await auditResults(tx, clinicId, opts.names.userId, shown);
      } else if (opts.names && shown.length) {
        // everything that changes what the list shows is in the key: filters, page, and who is on it
        const key = [
          `from=${opts.from?.toISOString() ?? ''}`, `to=${opts.to?.toISOString() ?? ''}`, `outcome=${opts.outcome ?? ''}`, `channel=${opts.channel ?? ''}`,
          `emergency=${opts.emergency ?? ''}`, `review=${opts.needsReview ?? ''}`, `refusal=${opts.refusal ?? ''}`, `before=${opts.before ? `${opts.before.startedAt}|${opts.before.id}` : ''}`, `limit=${opts.limit}`, patientSetKey(shown),
        ].join(';');
        await recordView(tx, { clinicId, actor: actorOf(opts.names.userId), action: 'calls.listed', entity: 'call', entityId: key }, 5);
      }
      const ctx = (col: string) => phiContext(clinicId, col);
      return rows.map(({ firstNameEnc, lastNameEnc, ...r }) => ({
        ...r, voiceSeconds: r.voiceSeconds === null ? null : Number(r.voiceSeconds),
        patientName: opts.names && firstNameEnc && lastNameEnc
          ? `${this.cipher.decrypt(firstNameEnc, ctx('patients.first_name'))} ${this.cipher.decrypt(lastNameEnc, ctx('patients.last_name'))}` : null,
      }));
    });
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
      const callTasks = await tx.select({ id: tasks.id, type: tasks.type, status: tasks.status }).from(tasks).where(eq(tasks.callId, callId));
      const [summary] = await tx.select().from(callSummaries).where(and(eq(callSummaries.clinicId, clinicId), eq(callSummaries.callId, callId)));
      // what the call booked or cancelled, so the call page can link to it on the schedule
      const changed = await tx.select({ id: appointments.id, startsAt: appointments.startsAt, providerId: appointments.providerId, visitTypeId: appointments.visitTypeId,
        status: appointments.status, createdByCallId: appointments.createdByCallId }).from(appointments)
        .where(and(eq(appointments.clinicId, clinicId), or(eq(appointments.createdByCallId, callId), eq(appointments.cancelledByCallId, callId))))
        .orderBy(appointments.startsAt);
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'call.transcript.viewed', entity: 'call', entityId: callId, callId });
      // who the caller was, when the agent verified them: part of the same view
      const [caller] = call.patientId
        ? await tx.select({ id: patients.id, firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc }).from(patients).where(and(eq(patients.clinicId, clinicId), eq(patients.id, call.patientId)))
        : [];
      const ctx = phiContext(clinicId, 'call_segments.text');
      return {
        id: call.id, startedAt: call.startedAt, endedAt: call.endedAt, outcome: call.outcome, emergency: call.emergencyFlag,
        closeReason: call.closeReason, voiceSeconds: call.voiceSeconds === null ? null : Number(call.voiceSeconds), channel: call.channel,
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
        })),
      };
    });
  }

  /**
   * The queue with its details and notes decrypted; one audit row per task shown.
   * Filters run in the database, so a task that is not shown is not read or audited.
   */
  async listTasks(clinicId: string, opts: { status: 'open' | 'done'; limit: number; type?: TaskType; assignee?: { userId: string } | 'unassigned' }, userId: string) {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select({ task: tasks, firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc, summary: callSummaries })
        .from(tasks).leftJoin(patients, eq(patients.id, tasks.patientId)).leftJoin(callSummaries, eq(callSummaries.callId, tasks.callId))
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.status, opts.status), opts.type ? eq(tasks.type, opts.type) : undefined,
          opts.assignee === 'unassigned' ? isNull(tasks.assigneeUserId) : opts.assignee ? eq(tasks.assigneeUserId, opts.assignee.userId) : undefined))
        .orderBy(opts.status === 'open' ? tasks.createdAt : desc(tasks.doneAt)).limit(opts.limit);
      const notes = rows.length
        ? await tx.select().from(taskNotes).where(and(eq(taskNotes.clinicId, clinicId), inArray(taskNotes.taskId, rows.map((r) => r.task.id)))).orderBy(taskNotes.createdAt, taskNotes.id)
        : [];
      if (rows.length) {
        await tx.insert(auditLogs).values(rows.map(({ task }) => ({ clinicId, actor: actorOf(userId), action: 'task.viewed', entity: 'task', entityId: task.id, callId: task.callId })));
      }
      const ctx = (col: string) => phiContext(clinicId, col);
      return rows.map(({ task, firstNameEnc, lastNameEnc, summary }) => ({
        id: task.id, type: task.type, status: task.status, callId: task.callId, patientId: task.patientId, createdAt: task.createdAt,
        assigneeUserId: task.assigneeUserId, assignedByUserId: task.assignedByUserId, claimedAt: task.claimedAt, doneAt: task.doneAt, doneByUserId: task.doneByUserId, outcome: task.outcome,
        patientName: firstNameEnc && lastNameEnc
          ? `${this.cipher.decrypt(firstNameEnc, ctx('patients.first_name'))} ${this.cipher.decrypt(lastNameEnc, ctx('patients.last_name'))}`
          : null,
        details: JSON.parse(this.cipher.decrypt(task.detailsEnc, ctx('tasks.details'))) as Record<string, string>,
        // what the call's summary suggests staff do, for a request the assistant created
        followUp: summary ? decryptSummary(this.cipher, clinicId, summary).followUp : null,
        notes: notes.filter((n) => n.taskId === task.id).map((n) => ({ id: n.id, authorUserId: n.authorUserId, at: n.createdAt, body: this.cipher.decrypt(n.bodyEnc, ctx('task_notes.body')) })),
      }));
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

  /** Gives an open request to a teammate, whoever holds it now. Owners and managers only; the caller checks the teammate's role. */
  async assignTask(clinicId: string, taskId: string, assigneeId: string, byUserId: string): Promise<'assigned' | 'taken' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const updated = await tx.update(tasks).set({ assigneeUserId: assigneeId, assignedByUserId: byUserId, claimedAt: new Date() })
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.id, taskId), eq(tasks.status, 'open'))).returning({ id: tasks.id });
      if (updated.length) {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(byUserId), action: 'task.assigned', entity: 'task', entityId: taskId });
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
        .returning({ id: tasks.id });
      if (updated.length) {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: override ? 'task.released.override' : 'task.released', entity: 'task', entityId: taskId });
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
        .returning({ id: tasks.id });
      if (updated.length) {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'task.claimed', entity: 'task', entityId: taskId });
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
        .returning({ id: tasks.id });
      if (updated.length) {
        await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'task.done', entity: 'task', entityId: taskId });
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
      const rows = await tx.select({ startedAt: calls.startedAt, outcome: calls.outcome, closeReason: calls.closeReason, voiceSeconds: calls.voiceSeconds })
        .from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.channel, 'phone'), sql`${calls.startedAt} >= ${from}`));
      const requests = await tx.select({ createdAt: tasks.createdAt }).from(tasks)
        .innerJoin(calls, eq(calls.id, tasks.callId))
        .where(and(eq(tasks.clinicId, clinicId), eq(calls.channel, 'phone'), sql`${tasks.createdAt} >= ${from}`));
      return { calls: rows.map((r) => ({ ...r, voiceSeconds: r.voiceSeconds === null ? 0 : Number(r.voiceSeconds) })), requests: requests.map((r) => r.createdAt) };
    });
  }

  /** Open requests nobody has claimed, oldest first: type and age only, so the home screen shows them without reading patient data. */
  async waitingTasks(clinicId: string, limit = 20) {
    return withClinic(this.db, clinicId, (tx) => tx.select({ id: tasks.id, type: tasks.type, createdAt: tasks.createdAt, callId: tasks.callId }).from(tasks)
      .where(and(eq(tasks.clinicId, clinicId), eq(tasks.status, 'open'), isNull(tasks.assigneeUserId)))
      .orderBy(tasks.createdAt).limit(limit));
  }

  /** Booked time in [from, to), for the open-slot search. No patient data, so no audit row. */
  async busy(clinicId: string, q: { from: Date; to: Date; except?: string }) {
    return withClinic(this.db, clinicId, (tx) => tx.select({ providerId: appointments.providerId, start: appointments.startsAt, end: appointments.endsAt })
      .from(appointments).where(and(eq(appointments.clinicId, clinicId), eq(appointments.status, 'booked'),
        lt(appointments.startsAt, q.to), sql`${appointments.endsAt} > ${q.from}`, q.except ? sql`${appointments.id} <> ${q.except}` : undefined)));
  }

  async settings(clinicId: string): Promise<unknown | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [row] = await tx.select({ config: clinics.config }).from(clinics).where(eq(clinics.id, clinicId));
      return row?.config ?? null;
    });
  }

  /** Saves a validated ClinicConfig. The caller checks that the id and phone numbers are unchanged. */
  async saveSettings(clinicId: string, config: { name: string; timezone: string }, userId: string) {
    await withClinic(this.db, clinicId, async (tx) => {
      await tx.update(clinics).set({ name: config.name, timezone: config.timezone, config }).where(eq(clinics.id, clinicId));
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'clinic.settings.updated', entity: 'clinic', entityId: clinicId });
    });
  }

  /** Newest first. Pages by id, not time: one request can write several rows with the same timestamp. */
  async auditTrail(clinicId: string, opts: { beforeId?: number; limit: number; actions?: string[] }) {
    return withClinic(this.db, clinicId, (tx) => tx.select({
      id: auditLogs.id, at: auditLogs.at, actor: auditLogs.actor, action: auditLogs.action,
      entity: auditLogs.entity, entityId: auditLogs.entityId, callId: auditLogs.callId,
    }).from(auditLogs)
      .where(and(eq(auditLogs.clinicId, clinicId), opts.beforeId ? lt(auditLogs.id, opts.beforeId) : undefined,
        opts.actions?.length ? inArray(auditLogs.action, opts.actions) : undefined))
      .orderBy(desc(auditLogs.id)).limit(opts.limit));
  }
}
