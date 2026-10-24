// SPDX-License-Identifier: AGPL-3.0-only
import { callUsNumber, ClinicConfig, localName, localParts, speakSlot, textingOf, toMinutes } from '@attendra/core';
import type { EventSink } from '@attendra/core';
import { activeNumbers, allClinics, CallSummaryRepository, callFacts, type Database, ensureWorkerJobsView, KnowledgeRepository, type PhiCipher, phiContext, PostgresTaskQueue, purgeCallRecords, purgeWebhookRecords, schema, WebhookRepository, withClinic } from '@attendra/db';
import { type Embedder, indexDocument, LocalEmbedder, OpenAIEmbedder } from '@attendra/knowledge';
import type { Alerter, Logger } from '@attendra/observability';
import { deliver, type GuardOptions, payloadOf, type Resolver } from '@attendra/webhooks';
import { and, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import OpenAI from 'openai';
import type { Job, PgBoss } from 'pg-boss';
import { type FallbackEntry, fallbackEntry, type SmsSender, smsStatusUrl, type SpendTrigger, type TwilioFallback, TwilioMessenger, type TwilioSpendAlerts } from '@attendra/telephony';
import { CallJob, DeliveryJob, DocumentJob, ensureQueues, jobId, QUEUES, RequestJob, SmsStatusJob, WEBHOOK_RETRY, WebhookEventJob } from './queue';
import { JobError, LocalSummariser, ModelSummariser, type Summariser } from './summarise';

export interface WorkerDeps {
  boss: PgBoss;
  db: Database;
  cipher: PhiCipher;
  summariser: Summariser;
  /** Embeds the clinic's documents. The same model must embed the questions at call time. */
  embedder?: Embedder;
  log: Logger;
  now?: () => Date;
  /** Runs the daily purge on a schedule. Tests call it directly instead. */
  schedulePurge?: boolean;
  /** The retry policy, for tests that cannot wait for the real backoff. */
  retry?: Parameters<typeof ensureQueues>[1];
  /** Where the worker's own events go (call.completed, call.summary.ready). */
  events?: EventSink;
  /** Webhook delivery: plain HTTP to this machine for local development, and a resolver for tests. */
  webhooks?: GuardOptions & { resolve?: Resolver; timeoutMs?: number };
  /** Sends texts (Twilio). Without it, nothing is texted and the request stays as it was closed. */
  texts?: SmsSender;
  /** The voice service's public address, where Twilio reports delivery; and the clinic's daily text limit. */
  sms?: { publicUrl?: string; dailyCap?: number; monthlyCap?: number };
  /** Where alerts go (Slack): a job that gave up, texts the carrier refuses. */
  alerts?: Alerter;
  /** The backup route in Twilio (a Function on the trunk's disaster recovery URL): kept in place and current. */
  fallback?: { client: Pick<TwilioFallback, 'ensure' | 'sync'>; trunkSid: string; slackWebhookUrl?: string };
  /** Twilio's daily spend alerts, kept in place at each start. */
  spend?: { client: Pick<TwilioSpendAlerts, 'ensure'>; callbackUrl: string; triggers: SpendTrigger[] };
}

/**
 * The summariser for this environment: the model when there is an OpenAI key, the
 * local one when there is not. The model name comes from the environment.
 */
export function summariserFromEnv(env: { OPENAI_API_KEY?: string; ATTENDRA_SUMMARY_MODEL?: string }): Summariser {
  if (!env.OPENAI_API_KEY) return new LocalSummariser();
  return new ModelSummariser(new OpenAI({ apiKey: env.OPENAI_API_KEY }), env.ATTENDRA_SUMMARY_MODEL || 'gpt-6-luna');
}

/** Embeddings for this environment: OpenAI's with a key (ATTENDRA_EMBEDDING_MODEL), local ones without. Every service must agree. */
export function embedderFromEnv(env: { OPENAI_API_KEY?: string; ATTENDRA_EMBEDDING_MODEL?: string }): Embedder {
  if (!env.OPENAI_API_KEY) return new LocalEmbedder();
  return new OpenAIEmbedder(new OpenAI({ apiKey: env.OPENAI_API_KEY }), env.ATTENDRA_EMBEDDING_MODEL || 'text-embedding-3-small');
}

/** Twilio's message statuses, as the few a clinic needs to see. The rest change nothing. */
const SMS_STATUS_MAP: Partial<Record<SmsStatusJob['status'], 'sent' | 'delivered' | 'undelivered' | 'failed'>> = {
  sent: 'sent', delivered: 'delivered', read: 'delivered', undelivered: 'undelivered', failed: 'failed', canceled: 'failed',
};
const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, undelivered: 2, failed: 2, delivered: 3 };

/** Whether a clinic-local minute of the day falls in quiet hours, which may run past midnight (20:00 to 08:00). */
export function quiet(minute: number, from: string, to: string): boolean {
  const f = toMinutes(from);
  const t = toMinutes(to);
  if (f === t) return false;
  return f < t ? minute >= f && minute < t : minute >= f || minute < t;
}

/** The job handlers, apart from pg-boss, so tests can run them one at a time. */
export function handlers(d: Omit<WorkerDeps, 'boss'> & { boss: Pick<PgBoss, 'send'> }) {
  const summaries = new CallSummaryRepository(d.db, d.cipher);
  const hooks = new WebhookRepository(d.db, d.cipher);
  const tasks = new PostgresTaskQueue(d.db, d.cipher, 'worker');
  const emit: EventSink['emit'] = (clinicId, e) => (d.events?.emit(clinicId, e) ?? Promise.resolve()).catch((err: unknown) =>
    d.log.warn({ clinic_id: clinicId, type: e.type, err: { message: (err as Error).message } }, 'could not queue an event'));
  const now = d.now ?? (() => new Date());
  /** Reminder texts the carrier refused for now (an outage, a rate limit), by visit: tried again, 3 times at most. */
  const reminderTries = new Map<string, number>();
  return {
    /** A closed call: queue what every closed call needs, once each. */
    async callCompleted(job: CallJob) {
      const data = CallJob.parse(job);
      await d.boss.send(QUEUES.summariseCall, data, { id: jobId(QUEUES.summariseCall, data.callId) });
      const facts = await callFacts(d.db, data.clinicId, data.callId);
      if (facts?.endedAt) await emit(data.clinicId, { type: 'call.completed', key: data.callId, occurredAt: new Date(facts.endedAt), data: facts });
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
      // the codes only; the summary's text stays in Attendra
      if (saved === 'saved') await emit(clinicId, { type: 'call.summary.ready', key: callId, data: { callId, intent: summary.intent, sentiment: summary.sentiment, needsReview: summary.needsReview } });
      // a call that ended with the caller's request unfinished becomes a request, so a person gets back to them
      // one open request per caller: another call from the same number about an unfinished thing joins the one the team has
      if (saved === 'saved' && needsFollowUp(call, summary) && !(await summaries.openRequestFromSameNumber(clinicId, callId))) {
        const task = await tasks.create(clinicId, {
          type: 'follow_up', callId, patientId: call.patientId, idempotencyKey: `follow_up:${callId}`,
          details: {
            reason: summary.reviewReason ?? 'The call ended without the caller\'s request done.',
            ...(summary.followUp ? { suggested: summary.followUp } : {}),
            // whoever picks it up can call back without opening the call
            ...(call.fromNumber ? { callback_number: call.fromNumber } : {}),
          },
        });
        if (task.created) await emit(clinicId, { type: 'request.created', key: task.id, data: { requestId: task.id, type: 'follow_up', patientId: call.patientId, callId } });
      }
      // an emergency is a check on the caller, not a callback: always in the team's queue, urgent, even when they said no to a callback
      if (saved === 'saved' && call.emergency) {
        const task = await tasks.create(clinicId, {
          type: 'follow_up', callId, patientId: call.patientId, idempotencyKey: `emergency:${callId}`, urgent: true,
          details: {
            reason: 'Emergency language on the call. Check on the caller as your protocol says.',
            ...(summary.followUp ? { suggested: summary.followUp } : {}),
            ...(call.fromNumber ? { callback_number: call.fromNumber } : {}),
          },
        });
        if (task.created) await emit(clinicId, { type: 'request.created', key: task.id, data: { requestId: task.id, type: 'follow_up', patientId: call.patientId, callId } });
      }
      return saved;
    },

    /** Transcripts, summaries, call actions and webhook events past each clinic's retention period. Counts are audited, never content. */
    async purgeRetention() {
      const results: { clinicId: string; transcriptLines: number; summaries: number; callActions: number; webhookEvents: number; webhookAttempts: number }[] = [];
      for (const clinic of await allClinics(d.db)) {
        const parsed = ClinicConfig.safeParse(clinic.config);
        const days = parsed.success ? parsed.data.retentionDays : 2555;
        const before = new Date(now().getTime() - days * 86_400_000);
        const counts = await purgeCallRecords(d.db, clinic.id, before);
        const webhooks = await purgeWebhookRecords(d.db, clinic.id, before);
        results.push({ clinicId: clinic.id, ...counts, ...webhooks });
      }
      const total = (k: 'transcriptLines' | 'summaries' | 'callActions' | 'webhookEvents' | 'webhookAttempts') => results.reduce((n, r) => n + r[k], 0);
      d.log.info({ clinics: results.length, transcript_lines: total('transcriptLines'), summaries: total('summaries'), call_actions: total('callActions'), webhook_events: total('webhookEvents'), webhook_attempts: total('webhookAttempts') }, 'retention purge done');
      return results;
    },

    /**
     * Reminder texts, for every clinic that sends them: each booked visit between 2 and
     * `hoursBefore` hours away that has had none, for someone who said yes to them. Not
     * in the clinic's quiet hours: those wait for the next run after them, while the visit
     * is still 2 hours away. Each visit is claimed before its text goes, so two workers
     * never send two.
     */
    /**
     * What the backup route does for each of our numbers, as of now: ring the clinic's
     * front desk or on-call phone, or say where to go. Only what changed is written.
     */
    async fallbackSync() {
      if (!d.fallback) return 'off';
      const at = now();
      const entries = new Map<string, FallbackEntry>();
      for (const row of await activeNumbers(d.db)) {
        const parsed = ClinicConfig.safeParse(row.config);
        if (parsed.success) entries.set(row.e164, fallbackEntry(parsed.data, at));
      }
      const done = await d.fallback.client.sync(entries);
      if (done.written || done.removed) d.log.info({ numbers: entries.size, ...done }, 'backup route updated');
      return done;
    },

    async appointmentReminders() {
      const at = now();
      let sent = 0;
      for (const row of await allClinics(d.db)) {
        // a closed clinic (a location removed) texts nobody
        if (row.closedAt) continue;
        const parsed = ClinicConfig.safeParse(row.config);
        if (!parsed.success) continue;
        const config = parsed.data;
        // no reminder goes out under 2 hours before a visit; a setting of 2 hours means 3, so it can send at all
        const r = textingOf(config).reminders;
        if (!r.enabled || quiet(localParts(at, config.timezone).minutes, r.quietFrom, r.quietTo)) continue;
        const clinicId = config.id;
        const due = await withClinic(d.db, clinicId, (tx) => tx.select({ a: schema.appointments, p: schema.patients, language: schema.calls.language })
          .from(schema.appointments)
          .innerJoin(schema.patients, eq(schema.patients.id, schema.appointments.patientId))
          .leftJoin(schema.calls, eq(schema.calls.id, schema.appointments.createdByCallId))
          .where(and(
            eq(schema.appointments.clinicId, clinicId), eq(schema.appointments.status, 'booked'), isNull(schema.appointments.reminderSentAt),
            gt(schema.appointments.startsAt, new Date(at.getTime() + 2 * 3_600_000)), lte(schema.appointments.startsAt, new Date(at.getTime() + Math.max(r.hoursBefore, 3) * 3_600_000)),
            isNotNull(schema.patients.smsConsentAt), isNotNull(schema.patients.phoneEnc),
          )));
        if (!due.length) continue;
        const messenger = new TwilioMessenger(d.db, d.cipher, d.texts ?? null, () => config.phoneNumbers[0]!, {
          actor: 'worker', dailyCap: d.sms?.dailyCap, monthlyCap: d.sms?.monthlyCap, alerts: d.alerts, log: d.log,
          statusCallback: d.sms?.publicUrl ? (id) => smsStatusUrl(d.sms!.publicUrl!, id) : undefined,
        });
        for (const { a, p, language } of due) {
          const claimed = await withClinic(d.db, clinicId, (tx) => tx.update(schema.appointments).set({ reminderSentAt: now() })
            .where(and(eq(schema.appointments.id, a.id), isNull(schema.appointments.reminderSentAt))).returning({ id: schema.appointments.id }));
          if (!claimed.length) continue;
          const lang = config.languages.includes(language as never) ? (language as typeof config.primaryLanguage) : config.primaryLanguage;
          const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
          // "Hi Abdul, a reminder of Flippy's check-up with Dr. Ruiz": the owner and the pet by name; a person by
          // first name, with the doctor, and never the kind of visit
          const pets = config.industry === 'vet';
          const firstName = d.cipher.decrypt(p.firstNameEnc, ctx('first_name'));
          const owner = pets && p.guardianNameEnc ? d.cipher.decrypt(p.guardianNameEnc, ctx('guardian_name')).trim().split(/\s+/)[0] : '';
          const provider = config.providers.find((x) => x.id === a.providerId);
          const visit = pets ? config.visitTypes.find((x) => x.id === a.visitTypeId) : undefined;
          const result = await messenger.sendTemplate(clinicId, {
            to: d.cipher.decrypt(p.phoneEnc!, ctx('phone')), template: 'reminder', language: lang, kind: 'reminder',
            vars: {
              clinic: config.name, when: speakSlot(a.startsAt, config.timezone, lang), clinicPhone: callUsNumber(config),
              ...(pets ? { pet: firstName, ...(owner ? { name: owner } : {}) } : { name: firstName }),
              ...(provider && provider.kind !== 'room' ? { provider: localName(provider, lang) } : {}),
              ...(visit ? { visit: localName(visit, lang).toLowerCase() } : {}),
            },
            idempotencyKey: `reminder:${a.id}:${a.startsAt.toISOString()}`, about: { patientId: p.id, appointmentId: a.id },
          });
          if (result.messageId) await withClinic(d.db, clinicId, (tx) => tx.update(schema.appointments).set({ reminderSmsId: result.messageId }).where(eq(schema.appointments.id, a.id)));
          if (result.status === 'sent') { sent++; reminderTries.delete(a.id); continue; }
          // a refusal that may pass (the carrier, a rate limit): the visit is let go, so a later run tries again
          const tries = (reminderTries.get(a.id) ?? 0) + 1;
          if (result.status === 'not_sent' && (result.reason === 'carrier' || result.reason === 'rate_limited') && tries < 3) {
            reminderTries.set(a.id, tries);
            await withClinic(d.db, clinicId, (tx) => tx.update(schema.appointments).set({ reminderSentAt: null }).where(eq(schema.appointments.id, a.id)));
          } else reminderTries.delete(a.id);
        }
      }
      if (sent) d.log.info({ sent }, 'reminder texts sent');
      return { sent };
    },

    /** Indexes one uploaded document. Unchanged content with the same model is left as it is. */
    async indexDocument(job: DocumentJob) {
      const { clinicId, documentId } = DocumentJob.parse(job);
      const result = await indexDocument(new KnowledgeRepository(d.db), d.embedder ?? new LocalEmbedder(), clinicId, documentId);
      d.log.info({ clinic_id: clinicId, document_id: documentId, result }, 'document indexed');
      return result;
    },

    /** An event: stored once, then one delivery job for each endpoint that is on and wants it. */
    async webhookEvent(job: WebhookEventJob) {
      const e = WebhookEventJob.parse(job);
      await hooks.record({ id: e.id, clinicId: e.clinicId, type: e.type, data: e.data, occurredAt: e.occurredAt });
      const endpoints = await hooks.subscribers(e.clinicId, e.type);
      for (const endpointId of endpoints) {
        await d.boss.send(QUEUES.deliverWebhook, { clinicId: e.clinicId, endpointId, eventId: e.id }, { id: jobId(QUEUES.deliverWebhook, `${endpointId}|${e.id}`) });
      }
      return endpoints.length;
    },

    /**
     * One attempt at one delivery, logged whatever happens. A failure is thrown so the
     * queue retries it; after the last retry it counts against the endpoint, which is
     * turned off after repeated failures.
     */
    async deliverWebhook(job: DeliveryJob, meta: { retryCount: number; retryLimit?: number } = { retryCount: 0 }) {
      const { clinicId, endpointId, eventId } = DeliveryJob.parse(job);
      const target = await hooks.secrets(clinicId, endpointId);
      if (!target || !target.enabled) return 'skipped'; // deleted or turned off since
      const event = await hooks.event(clinicId, eventId);
      if (!event) return 'skipped';
      const result = await deliver({ url: target.url, secrets: target.secrets }, { id: event.id, body: payloadOf({ ...event, type: event.type as never }, { omitPatientIds: target.omitPatientIds }) }, d.webhooks);
      await hooks.logAttempt(clinicId, { endpointId, eventId, kind: 'automatic', attempt: meta.retryCount + 1, statusCode: result.status, durationMs: result.ms, error: result.error });
      if (result.ok) { await hooks.delivered(clinicId, endpointId); return 'delivered'; }
      if (meta.retryCount >= (meta.retryLimit ?? WEBHOOK_RETRY.retryLimit)) {
        const { disabled } = await hooks.exhausted(clinicId, endpointId);
        if (disabled) d.log.warn({ clinic_id: clinicId, endpoint_id: endpointId }, 'webhook endpoint turned off after repeated failures');
      }
      throw new JobError(`webhook_${result.error ?? 'failed'}`);
    },

    /**
     * A refill the team approved: one text to the number the caller left, from the
     * clinic's own number, saying it is ready to pick up and never what it is.
     */
    async requestReady(job: RequestJob): Promise<'sent' | 'off' | 'not_sent' | 'skipped'> {
      const { clinicId, taskId } = RequestJob.parse(job);
      const found = await withClinic(d.db, clinicId, async (tx) => {
        const [task] = await tx.select().from(schema.tasks).where(and(eq(schema.tasks.clinicId, clinicId), eq(schema.tasks.id, taskId)));
        const [clinic] = await tx.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, clinicId));
        // the text goes in the language the call was held in
        const [call] = task?.callId ? await tx.select({ language: schema.calls.language }).from(schema.calls).where(and(eq(schema.calls.clinicId, clinicId), eq(schema.calls.id, task.callId))) : [];
        return task && clinic ? { task, config: ClinicConfig.parse(clinic.config), language: call?.language ?? null } : null;
      });
      // what the team decided, in one text each: ready to pick up, sent to the pharmacy, or please call us
      const byOutcome: Record<string, 'request_ready' | 'refill_sent' | 'refill_not_approved'> = { refill_ready: 'request_ready', refill_sent: 'refill_sent', refill_declined: 'refill_not_approved' };
      const template = found?.task.outcome ? byOutcome[found.task.outcome] : undefined;
      if (!found || found.task.type !== 'refill' || !template) return 'skipped';
      const details = JSON.parse(d.cipher.decrypt(found.task.detailsEnc, phiContext(clinicId, 'tasks.details'))) as Record<string, string>;
      // "sent to the pharmacy" names the pharmacy, never the medicine; one picked up at the clinic is "ready" instead
      const pharmacy = details.pharmacy?.trim();
      if (template === 'refill_sent' && (!pharmacy || /pick ?up|clinic|recoger/i.test(pharmacy))) return 'skipped';
      const { config } = found;
      // a request from a call is texted only when the caller said yes to the text on it; one the team
      // logged itself, on the team's word, as before
      if (found.task.callId ? details.texts !== 'yes' : details.texts === 'no') return 'skipped';
      const language = config.languages.includes(found.language as never) ? (found.language as typeof config.primaryLanguage) : config.primaryLanguage;
      // with the clinic's texting off (its registration not approved), the text is recorded as not sent, and why
      const messenger = new TwilioMessenger(d.db, d.cipher, textingOf(config).enabled ? d.texts ?? null : null, () => config.phoneNumbers[0]!, {
        actor: 'worker', dailyCap: d.sms?.dailyCap, monthlyCap: d.sms?.monthlyCap, alerts: d.alerts, log: d.log,
        statusCallback: d.sms?.publicUrl ? (id) => smsStatusUrl(d.sms!.publicUrl!, id) : undefined,
      });
      // a refusal (texts off, opted out, no number) is kept on the request for staff to see
      const result = await messenger.sendTemplate(clinicId, {
        to: details.callback_number ?? '', template,
        // the pet by name when the request has it ("Flippy's request is ready"); never the medicine
        vars: { clinic: config.name, clinicPhone: callUsNumber(config), ...(details.pet_name ? { pet: details.pet_name } : {}), ...(template === 'refill_sent' ? { pharmacy: pharmacy! } : {}) },
        idempotencyKey: template === 'request_ready' ? `request-ready:${taskId}` : `${template}:${taskId}`, language, kind: 'auto',
        about: { callId: found.task.callId, patientId: found.task.patientId, taskId },
      });
      if (result.status !== 'not_sent') return 'sent';
      if (result.reason === 'carrier') throw new JobError('sms_failed'); // the carrier may take it on a retry
      if (result.reason === 'texting_off') d.log.info({ clinic_id: clinicId, task_id: taskId, template }, 'texts are off: no refill text sent');
      return result.reason === 'texting_off' ? 'off' : 'not_sent';
    },

    /**
     * A delivery report from Twilio, by its message id. A status never goes backwards
     * (a late "sent" after "delivered"), and a number the carrier says opted out is
     * marked so the clinic does not try it again.
     */
    async smsStatus(job: SmsStatusJob) {
      const { clinicId, messageSid, status, errorCode } = SmsStatusJob.parse(job);
      const next = SMS_STATUS_MAP[status];
      return withClinic(d.db, clinicId, async (tx) => {
        const where = and(eq(schema.smsMessages.clinicId, clinicId), eq(schema.smsMessages.providerSid, messageSid));
        const [row] = await tx.select().from(schema.smsMessages).where(where);
        if (!row) return 'unknown';
        if (next && (STATUS_RANK[next] ?? 0) > (STATUS_RANK[row.status] ?? 0)) {
          await tx.update(schema.smsMessages).set({
            status: next, ...(next === 'delivered' ? { deliveredAt: now() } : {}), ...(errorCode ? { errorCode, failureReason: 'carrier' } : {}),
          }).where(where);
          await tx.insert(schema.auditLogs).values({ clinicId, actor: 'worker', action: `sms.status.${next}`, entity: 'sms', entityId: messageSid });
          // a text the carrier would not deliver: often a texting registration (A2P) problem, never one person's fault
          if ((next === 'failed' || next === 'undelivered') && errorCode !== '21610') d.alerts?.alert('text_failed', `A text was not delivered (Twilio error ${errorCode ?? 'none given'}). Clinic ${clinicId}.`);
        }
        if (errorCode === '21610') {
          await tx.insert(schema.smsOptOuts).values({ clinicId, toHash: row.toHash, status: 'opted_out', source: 'carrier' })
            .onConflictDoUpdate({ target: [schema.smsOptOuts.clinicId, schema.smsOptOuts.toHash], set: { status: 'opted_out', source: 'carrier', at: now() } });
        }
        return 'updated';
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
  const each = <T>(fn: (data: T, job: Job<T>) => Promise<unknown>) => async (jobs: Job<T>[]) => { for (const job of jobs) await fn(job.data, job); };
  const poll = { pollingIntervalSeconds: 1 };
  await d.boss.work<CallJob>(QUEUES.callCompleted, poll, each((data) => h.callCompleted(data)));
  await d.boss.work<CallJob>(QUEUES.summariseCall, { ...poll, localConcurrency: 2 }, each((data) => h.summariseCall(data)));
  await d.boss.work(QUEUES.purgeRetention, each(() => h.purgeRetention()));
  await d.boss.work<DocumentJob>(QUEUES.indexDocument, poll, each((data) => h.indexDocument(data)));
  await d.boss.work<WebhookEventJob>(QUEUES.webhookEvent, poll, each((data) => h.webhookEvent(data)));
  const retryLimit = d.retry?.retryLimit ?? WEBHOOK_RETRY.retryLimit;
  await d.boss.work<DeliveryJob>(QUEUES.deliverWebhook, { ...poll, localConcurrency: 4 }, each((data, job) => h.deliverWebhook(data, { retryCount: job.retryCount, retryLimit })));
  await d.boss.work<SmsStatusJob>(QUEUES.smsStatus, poll, each((data) => h.smsStatus(data)));
  await d.boss.work<RequestJob>(QUEUES.requestReady, poll, each((data) => h.requestReady(data)));
  await d.boss.work(QUEUES.appointmentReminders, each(() => h.appointmentReminders()));
  await d.boss.work(QUEUES.fallbackSync, each(async () => { await h.fallbackSync(); }));
  // the backup route in place before anything else needs it; a failure is said, and tried again at the next start
  if (d.fallback) {
    const f = d.fallback;
    void f.client.ensure({ trunkSid: f.trunkSid, slackWebhookUrl: f.slackWebhookUrl })
      .then((url) => { d.log.info({ url }, 'backup route in place'); return h.fallbackSync(); })
      .catch((err: unknown) => {
        d.log.error({ err: { message: (err as Error).message } }, 'backup route not in place');
        d.alerts?.alert('backup_route', `The backup route could not be set up in Twilio: ${(err as Error).message.slice(0, 120)}. Calls still work; an outage would give callers an error tone.`);
      });
  }
  // the spend alerts in place; a failure is said, and tried again at the next start
  if (d.spend) {
    const s = d.spend;
    void s.client.ensure(s.callbackUrl, s.triggers)
      .then((r) => d.log.info({ ...r, lines: s.triggers.map((t) => `${t.category} $${t.usd}`) }, 'spend alerts in place'))
      .catch((err: unknown) => {
        d.log.error({ err: { message: (err as Error).message } }, 'spend alerts not in place');
        d.alerts?.alert('spend_alerts', `Twilio's daily spend alerts could not be set up: ${(err as Error).message.slice(0, 120)}. Texts and calls still work; a runaway would not be said until the bill.`);
      });
  }
  // nothing retries a dead letter: it is logged, with ids only, for someone to look at
  await d.boss.work<Record<string, unknown>>(QUEUES.deadLetter, each(async (data) => {
    d.log.error({ clinic_id: data.clinicId, call_id: data.callId }, 'a job failed every retry and was dead-lettered');
    d.alerts?.alert('job_failed', `A background job gave up after its retries${data.clinicId ? ` (clinic ${String(data.clinicId)})` : ''}: a summary, a text or a webhook was not done.`);
  }));
  // 03:00 UTC every day
  if (d.schedulePurge !== false) {
    await d.boss.schedule(QUEUES.purgeRetention, '0 3 * * *');
    await d.boss.schedule(QUEUES.appointmentReminders, '*/10 * * * *');
    if (d.fallback) await d.boss.schedule(QUEUES.fallbackSync, '*/10 * * * *');
  }
  d.log.info({ summariser: d.summariser.model, texts: !!d.texts }, 'worker started');
  return h;
}

/** Done outcomes: a booking, a change or a transfer to a person already settled the call. */
const SETTLED = new Set(['booked', 'rescheduled', 'cancelled', 'transferred']);

/**
 * Whether staff should get back to the caller: the summary flagged the call, nothing on
 * it settled what they wanted, and it did not already open a request (a callback, a
 * refill, a new patient). Emergencies have their own place at the top of Today.
 */
export function needsFollowUp(call: { outcome: string | null; emergency: boolean; tasks: { type: string }[]; transcript?: { speaker: 'caller' | 'agent'; text: string }[] }, summary: { needsReview: boolean }): boolean {
  // a caller who hung up before saying anything is a missed call in the list, not work for the team
  const spoke = (call.transcript ?? []).some((t) => t.speaker === 'caller' && t.text.trim().length > 0);
  return summary.needsReview && !call.emergency && call.tasks.length === 0 && !SETTLED.has(call.outcome ?? '') && !declinedCallback(call.transcript ?? []) && (spoke || call.transcript === undefined);
}

const OFFERED_CALLBACK = /\b(call(ing)? you back|callback|call back|have (someone|somebody|the team|a member of the team)[^.?!]* (call|contact|reach) you|devolver(le|te) la llamada|que (le|te) llamen)\b/i;
const NO = /^\W*(no|nope|nah|no thanks?|no thank you|not needed|no need|i'?m (fine|good|ok(ay)?)|that'?s (fine|ok(ay)?)|it'?s fine|no gracias|no hace falta)\b/i;
/**
 * The caller said no to the last callback the assistant offered: a follow-up request would
 * have the team call someone who said not to. The call is still flagged for review when the
 * summary says so; the summary says they declined.
 */
export function declinedCallback(transcript: { speaker: 'caller' | 'agent'; text: string }[]): boolean {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i]!;
    if (t.speaker !== 'agent' || !OFFERED_CALLBACK.test(t.text)) continue;
    const reply = transcript.slice(i + 1).find((x) => x.speaker === 'caller');
    return !!reply && NO.test(reply.text);
  }
  return false;
}
