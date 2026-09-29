// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { type Database, withClinic } from '../client';
import { type PhiCipher, phiContext } from '../crypto';
import { auditLogs, callActions, calls, callSegments, callSummaries, clinics, tasks } from '../schema';

export const INTENTS = ['book', 'reschedule', 'cancel', 'refill', 'question', 'callback', 'emergency', 'other'] as const;
export const SENTIMENTS = ['calm', 'frustrated', 'distressed'] as const;
export type Intent = (typeof INTENTS)[number];
export type Sentiment = (typeof SENTIMENTS)[number];

/** What the worker writes for a call. The three text fields are encrypted together. */
export interface CallSummary {
  summary: string;
  intent: Intent;
  sentiment: Sentiment;
  needsReview: boolean;
  reviewReason: string | null;
  followUp: string | null;
}

export interface StoredSummary extends CallSummary {
  model: string;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
}

/** Everything the summariser gets to see about one call. */
export interface CallForSummary {
  callId: string;
  clinicId: string;
  channel: 'phone' | 'web';
  outcome: string | null;
  emergency: boolean;
  closeReason: string | null;
  transcript: { speaker: 'caller' | 'agent'; text: string }[];
  /** Tool names and their results: codes like verified, booked, error. Never arguments. */
  actions: { tool: string; result: Record<string, unknown> }[];
  tasks: { type: string }[];
}

const WORKER = 'worker';
const BODY = 'call_summaries.body';

export function decryptSummary(cipher: PhiCipher, clinicId: string, row: typeof callSummaries.$inferSelect): StoredSummary {
  const body = JSON.parse(cipher.decrypt(row.bodyEnc, phiContext(clinicId, BODY))) as Pick<CallSummary, 'summary' | 'reviewReason' | 'followUp'>;
  return {
    ...body, intent: row.intent, sentiment: row.sentiment, needsReview: row.needsReview,
    model: row.model, createdAt: row.createdAt, reviewedAt: row.reviewedAt, reviewedByUserId: row.reviewedByUserId,
  };
}

/** Summaries: written by the worker, read and marked reviewed by staff. */
export class CallSummaryRepository {
  constructor(private readonly db: Database, private readonly cipher: PhiCipher) {}

  /**
   * The closed call, its transcript and what the tools did, for the summariser.
   * Reading the transcript is a PHI access, so the worker's read is audited in the
   * same transaction. Null when the call is not closed yet, or already summarised.
   */
  async forSummary(clinicId: string, callId: string): Promise<CallForSummary | 'not_closed' | 'done' | null> {
    return withClinic(this.db, clinicId, async (tx) => {
      const [call] = await tx.select().from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.id, callId)));
      if (!call) return null;
      if (!call.endedAt) return 'not_closed';
      const [existing] = await tx.select({ id: callSummaries.callId }).from(callSummaries).where(eq(callSummaries.callId, callId));
      if (existing) return 'done';
      const segments = await tx.select().from(callSegments).where(eq(callSegments.callId, callId)).orderBy(callSegments.startMs, callSegments.id);
      const actions = await tx.select({ tool: callActions.tool, result: callActions.result }).from(callActions).where(eq(callActions.callId, callId)).orderBy(callActions.id);
      const callTasks = await tx.select({ type: tasks.type }).from(tasks).where(eq(tasks.callId, callId));
      await tx.insert(auditLogs).values({ clinicId, actor: WORKER, action: 'call.transcript.read', entity: 'call', entityId: callId, callId });
      const ctx = phiContext(clinicId, 'call_segments.text');
      return {
        callId, clinicId, channel: call.channel, outcome: call.outcome, emergency: call.emergencyFlag, closeReason: call.closeReason,
        transcript: segments.map((s) => ({ speaker: s.speaker, text: this.cipher.decrypt(s.textEnc, ctx) })),
        actions: actions.map((a) => ({ tool: a.tool, result: a.result as Record<string, unknown> })),
        tasks: callTasks,
      };
    });
  }

  /** At most once per call: a retried job finds the summary already there. The write is audited with it. */
  async save(clinicId: string, callId: string, s: CallSummary, model: string): Promise<'saved' | 'exists'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const body = JSON.stringify({ summary: s.summary, reviewReason: s.reviewReason, followUp: s.followUp });
      const [row] = await tx.insert(callSummaries).values({
        callId, clinicId, bodyEnc: this.cipher.encrypt(body, phiContext(clinicId, BODY)),
        intent: s.intent, sentiment: s.sentiment, needsReview: s.needsReview, model,
      }).onConflictDoNothing().returning({ id: callSummaries.callId });
      if (!row) return 'exists';
      await tx.insert(auditLogs).values({ clinicId, actor: WORKER, action: 'call.summary.written', entity: 'call', entityId: callId, callId });
      return 'saved';
    });
  }

  /** Marks a flagged call as looked at, so it leaves Today and the review filter. */
  async markReviewed(clinicId: string, callId: string, userId: string): Promise<'reviewed' | 'not_found'> {
    return withClinic(this.db, clinicId, async (tx) => {
      const rows = await tx.update(callSummaries).set({ reviewedAt: new Date(), reviewedByUserId: userId })
        .where(and(eq(callSummaries.clinicId, clinicId), eq(callSummaries.callId, callId))).returning({ id: callSummaries.callId });
      if (!rows.length) return 'not_found';
      await tx.insert(auditLogs).values({ clinicId, actor: `user:${userId}`, action: 'call.summary.reviewed', entity: 'call', entityId: callId, callId });
      return 'reviewed';
    });
  }
}

/**
 * Deletes transcripts and summaries of calls that started before `before`, and
 * records how many, never what. Runs as the connecting (owner) role, like the
 * migrations: the application role cannot delete call records. Row Level Security
 * still applies, so the clinic is set for the transaction.
 */
export async function purgeCallRecords(db: Database, clinicId: string, before: Date): Promise<{ transcriptLines: number; summaries: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    const old = tx.select({ id: calls.id }).from(calls).where(and(eq(calls.clinicId, clinicId), lt(calls.startedAt, before)));
    const lines = await tx.delete(callSegments).where(and(eq(callSegments.clinicId, clinicId), inArray(callSegments.callId, old))).returning({ id: callSegments.id });
    const summaries = await tx.delete(callSummaries).where(and(eq(callSummaries.clinicId, clinicId), inArray(callSummaries.callId, old))).returning({ id: callSummaries.callId });
    const counts = { transcriptLines: lines.length, summaries: summaries.length };
    await tx.insert(auditLogs).values({ clinicId, actor: WORKER, action: 'retention.purged', entity: 'clinic', entityId: clinicId, counts });
    return counts;
  });
}

/** Every clinic's id and stored config, for jobs that run across clinics. Owner connection; no PHI. */
export async function allClinics(db: Database): Promise<{ id: string; config: unknown }[]> {
  return db.select({ id: clinics.id, config: clinics.config }).from(clinics);
}

/**
 * The worker's jobs, one clinic at a time, for the dashboard. pg-boss creates its own
 * schema when the worker first starts, after our migrations, so the worker creates
 * this view then. The view filters on the clinic of the current transaction, so the
 * application role only ever sees its own clinic's jobs. Job data holds ids only.
 */
export async function ensureWorkerJobsView(db: Database, schema = 'pgboss') {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('invalid job schema name');
  await db.execute(sql.raw(`
    create or replace view worker_jobs with (security_barrier) as
      select id, name, state::text as state, retry_count, retry_limit, data->>'clinicId' as clinic_id, data->>'callId' as call_id,
             created_on, started_on, completed_on, case when state::text = 'failed' then left(output->>'message', 80) end as failure
      from ${schema}.job
      where data->>'clinicId' = current_setting('app.clinic_id', true)`));
  await db.execute(sql.raw('grant select on worker_jobs to attendra_app'));
}

export interface WorkerJob { id: string; name: string; state: string; retryCount: number; retryLimit: number; callId: string | null; createdOn: Date; completedOn: Date | null; failure: string | null }

/** A clinic's recent jobs, or none when the worker has never run here. */
export async function workerJobs(db: Database, clinicId: string, opts: { callId?: string; limit?: number } = {}): Promise<WorkerJob[]> {
  const exists = (await db.execute(sql`select to_regclass('public.worker_jobs') is not null as ok`)).rows[0] as { ok: boolean };
  if (!exists.ok) return [];
  return withClinic(db, clinicId, async (tx) => {
    const rows = (await tx.execute(sql`select id, name, state, retry_count, retry_limit, call_id, created_on, completed_on, failure from worker_jobs
      where ${opts.callId ? sql`call_id = ${opts.callId}` : sql`true`} order by created_on desc limit ${opts.limit ?? 50}`)).rows as {
      id: string; name: string; state: string; retry_count: number; retry_limit: number; call_id: string | null; created_on: string | Date; completed_on: string | Date | null; failure: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id, name: r.name, state: r.state, retryCount: r.retry_count, retryLimit: r.retry_limit, callId: r.call_id,
      createdOn: new Date(r.created_on), completedOn: r.completed_on ? new Date(r.completed_on) : null, failure: r.failure,
    }));
  });
}
