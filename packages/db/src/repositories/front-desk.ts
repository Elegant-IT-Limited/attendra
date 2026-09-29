// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { memberships } from '../auth-schema';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, callActions, calls, callSegments, clinics, patients, tasks } from '../schema';

export type StaffRole = 'owner' | 'admin' | 'staff' | 'viewer';

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

const actorOf = (userId: string) => `user:${userId}`;

/**
 * What the staff dashboard reads and changes. Every method runs as the application
 * role inside one clinic's scope, and every read of patient data writes an audit
 * row in the same transaction, so a view that failed to audit also failed to show.
 */
export class FrontDeskRepository {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher) {}

  /**
   * The call list carries no patient data: times, outcome, flags and which tools ran.
   * Pages on (started_at, id), with the cursor keeping Postgres's full precision, so
   * two calls that start in the same instant are neither skipped nor repeated.
   */
  async listCalls(clinicId: string, opts: { before?: { startedAt: string; id: string }; limit: number }) {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select({
        id: calls.id, startedAt: calls.startedAt, cursor: sql<string>`${calls.startedAt}::text`, endedAt: calls.endedAt, outcome: calls.outcome,
        emergency: calls.emergencyFlag, closeReason: calls.closeReason, voiceSeconds: calls.voiceSeconds, channel: calls.channel,
        tools: sql<string[]>`coalesce(array_agg(distinct ${callActions.tool}) filter (where ${callActions.tool} is not null), '{}')`,
        verified: sql<boolean>`coalesce(bool_or((${callActions.result}->>'verified')::boolean), false)`,
      }).from(calls).leftJoin(callActions, eq(callActions.callId, calls.id))
        .where(and(eq(calls.clinicId, clinicId),
          opts.before ? sql`(${calls.startedAt}, ${calls.id}) < (${opts.before.startedAt}::timestamptz, ${opts.before.id}::uuid)` : undefined))
        .groupBy(calls.id).orderBy(desc(calls.startedAt), desc(calls.id)).limit(opts.limit);
      return rows.map((r) => ({ ...r, voiceSeconds: r.voiceSeconds === null ? null : Number(r.voiceSeconds) }));
    });
  }

  /** One call with its transcript. Reading the transcript is a PHI access. */
  async getCall(clinicId: string, callId: string, userId: string) {
    return withClinic(this.db, clinicId, async (tx) => {
      const [call] = await tx.select().from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.id, callId)));
      if (!call) return null;
      const segments = await tx.select().from(callSegments).where(eq(callSegments.callId, callId)).orderBy(callSegments.startMs, callSegments.id);
      const actions = await tx.select().from(callActions).where(eq(callActions.callId, callId)).orderBy(callActions.id);
      const callTasks = await tx.select({ id: tasks.id, type: tasks.type, status: tasks.status }).from(tasks).where(eq(tasks.callId, callId));
      await tx.insert(auditLogs).values({ clinicId, actor: actorOf(userId), action: 'call.transcript.viewed', entity: 'call', entityId: callId, callId });
      const ctx = phiContext(clinicId, 'call_segments.text');
      return {
        id: call.id, startedAt: call.startedAt, endedAt: call.endedAt, outcome: call.outcome, emergency: call.emergencyFlag,
        closeReason: call.closeReason, voiceSeconds: call.voiceSeconds === null ? null : Number(call.voiceSeconds), channel: call.channel,
        transcript: segments.map((s) => ({ speaker: s.speaker, text: this.cipher.decrypt(s.textEnc, ctx), startMs: s.startMs, endMs: s.endMs })),
        actions: actions.map((a) => ({ tool: a.tool, argumentNames: a.argsRedacted as string[], result: a.result as Record<string, unknown>, revision: a.taskRevision, at: a.createdAt })),
        tasks: callTasks,
      };
    });
  }

  /** The queue with its details decrypted; one audit row per task shown. */
  async listTasks(clinicId: string, opts: { status: 'open' | 'done'; limit: number }, userId: string) {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.select({ task: tasks, firstNameEnc: patients.firstNameEnc, lastNameEnc: patients.lastNameEnc })
        .from(tasks).leftJoin(patients, eq(patients.id, tasks.patientId))
        .where(and(eq(tasks.clinicId, clinicId), eq(tasks.status, opts.status)))
        .orderBy(opts.status === 'open' ? tasks.createdAt : desc(tasks.doneAt)).limit(opts.limit);
      if (rows.length) {
        await tx.insert(auditLogs).values(rows.map(({ task }) => ({ clinicId, actor: actorOf(userId), action: 'task.viewed', entity: 'task', entityId: task.id, callId: task.callId })));
      }
      const ctx = (col: string) => phiContext(clinicId, col);
      return rows.map(({ task, firstNameEnc, lastNameEnc }) => ({
        id: task.id, type: task.type, status: task.status, callId: task.callId, createdAt: task.createdAt,
        assigneeUserId: task.assigneeUserId, claimedAt: task.claimedAt, doneAt: task.doneAt, doneByUserId: task.doneByUserId,
        patientName: firstNameEnc && lastNameEnc
          ? `${this.cipher.decrypt(firstNameEnc, ctx('patients.first_name'))} ${this.cipher.decrypt(lastNameEnc, ctx('patients.last_name'))}`
          : null,
        details: JSON.parse(this.cipher.decrypt(task.detailsEnc, ctx('tasks.details'))) as Record<string, string>,
      }));
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

  /** Closes a task. Anyone on staff can close an unclaimed task; a claimed one only by its holder. */
  async completeTask(clinicId: string, taskId: string, userId: string): Promise<'done' | 'taken' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const updated = await tx.update(tasks).set({ status: 'done', doneAt: new Date(), doneByUserId: userId })
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
