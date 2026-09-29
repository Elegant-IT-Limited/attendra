// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { type PGliteLike, PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

/**
 * Background work, in Postgres through pg-boss: no Redis, and a job is in the same
 * database as the call it is about. Job data holds ids only, never patient data,
 * because pg-boss keeps it in clear and copies it to the dead-letter queue.
 */
export const QUEUES = {
  /** A call has closed. Fans out to the work every closed call needs. */
  callCompleted: 'call.completed',
  summariseCall: 'summarise-call',
  purgeRetention: 'purge-retention',
  smsStatus: 'sms-status',
  /** A document uploaded to the clinic's knowledge: text, chunks, embeddings. */
  indexDocument: 'index-document',
  /** Where a job goes after its last retry fails, to be looked at, not retried. */
  deadLetter: 'dead-letter',
} as const;

export const CallJob = z.object({ clinicId: z.string().min(1), callId: z.uuid() });
export type CallJob = z.infer<typeof CallJob>;

export const DocumentJob = z.object({ clinicId: z.string().min(1), documentId: z.uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/) });
export type DocumentJob = z.infer<typeof DocumentJob>;

export const SmsStatusJob = z.object({ clinicId: z.string().min(1), messageSid: z.string().regex(/^SM[0-9a-f]{32}$/i), status: z.enum(['queued', 'sent', 'delivered', 'undelivered', 'failed']) });
export type SmsStatusJob = z.infer<typeof SmsStatusJob>;

/** Retries back off from 15 seconds to an hour, five times, then the job is dead-lettered. */
export interface RetryPolicy { retryLimit: number; retryDelay: number; retryBackoff: boolean; retryDelayMax?: number; expireInSeconds?: number }
export const RETRY: RetryPolicy = { retryLimit: 5, retryDelay: 15, retryBackoff: true, retryDelayMax: 3600, expireInSeconds: 300 };

/**
 * A job id that is the same every time for the same work, so enqueueing twice (a
 * retried webhook, a restarted service) is one job, not two. pg-boss ignores a send
 * whose id already exists.
 */
export function jobId(kind: string, key: string): string {
  const h = createHash('sha256').update(`${kind}|${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** What the voice service and the API need from the queue: to say that something happened. */
export interface JobQueue {
  callCompleted(job: CallJob): Promise<void>;
  /** Once per document content: the same bytes uploaded again are the same job. */
  indexDocument(job: DocumentJob): Promise<void>;
}

export const noJobs: JobQueue = { callCompleted: async () => {}, indexDocument: async () => {} };

export function bossQueue(boss: PgBoss): JobQueue {
  return {
    async callCompleted(job) {
      await boss.send(QUEUES.callCompleted, CallJob.parse(job), { id: jobId(QUEUES.callCompleted, job.callId) });
    },
    async indexDocument(job) {
      await boss.send(QUEUES.indexDocument, DocumentJob.parse(job), { id: jobId(QUEUES.indexDocument, `${job.documentId}|${job.hash}`) });
    },
  };
}

/**
 * A pg-boss instance on a Postgres URL, or on the in-process PGlite the demo and the
 * tests use. `producer` is for services that only send jobs (voice, the API): they
 * leave maintenance and schedules to the worker.
 */
export function createBoss(target: { connectionString: string } | { pglite: PGliteLike }, opts: { producer?: boolean } = {}): PgBoss {
  const producer = opts.producer ? { supervise: false, schedule: false } : {};
  return 'pglite' in target
    ? new PgBoss({ db: fromPglite(target.pglite), backend: 'pglite', ...producer })
    : new PgBoss({ connectionString: target.connectionString, max: 4, ...producer });
}

/** Creates the queues with their retry policy. Safe to run on every start. Tests pass a faster policy. */
export async function ensureQueues(boss: PgBoss, retry: Partial<RetryPolicy> = RETRY) {
  const existing = new Set((await boss.getQueues()).map((q) => q.name));
  const create = async (name: string, options: Parameters<PgBoss['createQueue']>[1]) => { if (!existing.has(name)) await boss.createQueue(name, options); };
  await create(QUEUES.deadLetter, { retryLimit: 0, retentionSeconds: 30 * 86_400 });
  for (const name of [QUEUES.callCompleted, QUEUES.summariseCall, QUEUES.purgeRetention, QUEUES.smsStatus, QUEUES.indexDocument]) {
    const policy: Record<string, unknown> = { ...RETRY, ...retry };
    if (!policy.retryBackoff) delete policy.retryDelayMax; // only meaningful with backoff, and pg-boss refuses it otherwise
    await create(name, { ...policy, deadLetter: QUEUES.deadLetter });
  }
}
