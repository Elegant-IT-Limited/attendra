// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig } from '@attendra/core';
import { allClinics, CallSummaryRepository, type Database, ensureWorkerJobsView, type PhiCipher, purgeCallRecords, schema, withClinic } from '@attendra/db';
import type { Logger } from '@attendra/observability';
import { and, eq } from 'drizzle-orm';
import OpenAI from 'openai';
import type { Job, PgBoss } from 'pg-boss';
import { CallJob, ensureQueues, jobId, QUEUES, SmsStatusJob } from './queue';
import { JobError, LocalSummariser, ModelSummariser, type Summariser } from './summarise';

export interface WorkerDeps {
  boss: PgBoss;
  db: Database;
  cipher: PhiCipher;
  summariser: Summariser;
  log: Logger;
  now?: () => Date;
  /** Twilio delivery statuses. Off until Twilio sends them (ATTENDRA_SMS_STATUS=on). */
  smsStatus?: boolean;
  /** Runs the daily purge on a schedule. Tests call it directly instead. */
  schedulePurge?: boolean;
  /** The retry policy, for tests that cannot wait for the real backoff. */
  retry?: Parameters<typeof ensureQueues>[1];
}

/**
 * The summariser for this environment: the model when there is an OpenAI key, the
 * local one when there is not. The model name comes from the environment.
 */
export function summariserFromEnv(env: { OPENAI_API_KEY?: string; ATTENDRA_SUMMARY_MODEL?: string }): Summariser {
  if (!env.OPENAI_API_KEY) return new LocalSummariser();
  return new ModelSummariser(new OpenAI({ apiKey: env.OPENAI_API_KEY }), env.ATTENDRA_SUMMARY_MODEL || 'gpt-6-luna');
}

/** The job handlers, apart from pg-boss, so tests can run them one at a time. */
export function handlers(d: Omit<WorkerDeps, 'boss'> & { boss: Pick<PgBoss, 'send'> }) {
  const summaries = new CallSummaryRepository(d.db, d.cipher);
  const now = d.now ?? (() => new Date());
  return {
    /** A closed call: queue what every closed call needs, once each. */
    async callCompleted(job: CallJob) {
      const data = CallJob.parse(job);
      await d.boss.send(QUEUES.summariseCall, data, { id: jobId(QUEUES.summariseCall, data.callId) });
    },

    async summariseCall(job: CallJob): Promise<'saved' | 'exists' | 'gone'> {
      const { clinicId, callId } = CallJob.parse(job);
      const call = await summaries.forSummary(clinicId, callId);
      if (call === null) return 'gone'; // deleted, or never belonged to this clinic
      if (call === 'done') return 'exists';
      if (call === 'not_closed') throw new JobError('call_not_closed');
      const summary = await d.summariser.summarise(call);
      const saved = await summaries.save(clinicId, callId, summary, d.summariser.model);
      d.log.info({ call_id: callId, model: d.summariser.model, needs_review: summary.needsReview }, 'call summarised');
      return saved;
    },

    /** Transcripts and summaries past each clinic's retention period. Counts are audited, never content. */
    async purgeRetention() {
      const results: { clinicId: string; transcriptLines: number; summaries: number }[] = [];
      for (const clinic of await allClinics(d.db)) {
        const parsed = ClinicConfig.safeParse(clinic.config);
        const days = parsed.success ? parsed.data.retentionDays : 2555;
        const counts = await purgeCallRecords(d.db, clinic.id, new Date(now().getTime() - days * 86_400_000));
        results.push({ clinicId: clinic.id, ...counts });
      }
      d.log.info({ clinics: results.length, transcript_lines: results.reduce((n, r) => n + r.transcriptLines, 0), summaries: results.reduce((n, r) => n + r.summaries, 0) }, 'retention purge done');
      return results;
    },

    /** Records a text's delivery status from Twilio. A placeholder until Twilio status callbacks are wired to the queue. */
    async smsStatus(job: SmsStatusJob) {
      const { clinicId, messageSid, status } = SmsStatusJob.parse(job);
      return withClinic(d.db, clinicId, async (tx) => {
        const rows = await tx.update(schema.smsMessages).set({ status })
          .where(and(eq(schema.smsMessages.clinicId, clinicId), eq(schema.smsMessages.providerSid, messageSid))).returning({ id: schema.smsMessages.id });
        if (rows.length) await tx.insert(schema.auditLogs).values({ clinicId, actor: 'worker', action: `sms.status.${status}`, entity: 'sms', entityId: messageSid });
        return rows.length ? 'updated' : 'unknown';
      });
    },
  };
}

/**
 * Starts the worker on a running pg-boss: the queues with their retry policy, one
 * handler per queue, the nightly purge, and the jobs view the dashboard reads.
 */
export async function startWorker(d: WorkerDeps) {
  await ensureQueues(d.boss, d.retry);
  await ensureWorkerJobsView(d.db);
  const h = handlers(d);
  const each = <T>(fn: (data: T) => Promise<unknown>) => async (jobs: Job<T>[]) => { for (const job of jobs) await fn(job.data); };
  const poll = { pollingIntervalSeconds: 1 };
  await d.boss.work<CallJob>(QUEUES.callCompleted, poll, each(h.callCompleted));
  await d.boss.work<CallJob>(QUEUES.summariseCall, { ...poll, localConcurrency: 2 }, each(h.summariseCall));
  await d.boss.work(QUEUES.purgeRetention, each(() => h.purgeRetention()));
  if (d.smsStatus) await d.boss.work<SmsStatusJob>(QUEUES.smsStatus, each(h.smsStatus));
  // nothing retries a dead letter: it is logged, with ids only, for someone to look at
  await d.boss.work<Record<string, unknown>>(QUEUES.deadLetter, each(async (data) => {
    d.log.error({ clinic_id: data.clinicId, call_id: data.callId }, 'a job failed every retry and was dead-lettered');
  }));
  // 03:00 UTC every day
  if (d.schedulePurge !== false) await d.boss.schedule(QUEUES.purgeRetention, '0 3 * * *');
  d.log.info({ summariser: d.summariser.model, sms_status: !!d.smsStatus }, 'worker started');
  return h;
}
