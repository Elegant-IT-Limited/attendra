// SPDX-License-Identifier: AGPL-3.0-only
import { CALL_EVENTS_RETENTION_DAYS, inQuietHours, reminderDecision, type ReminderSkip, callUsNumber, ClinicConfig, dailyDigest, demoResetDue, isRefillDecision, localName, localParts, providerName, refillText, speakSlot, textingOf } from '@attendra/core';
import type { EventSink } from '@attendra/core';
import { activeNumbers, allClinics, CallSummaryRepository, callFacts, callsForDigest, configName, DEMO_NIGHTLY_ACTOR, demoClinics, type Database, ensureWorkerJobsView, KnowledgeRepository, lapseInvitations, type PhiCipher, phiContext, PostgresTaskQueue, purgeCallEvents, purgeCallRecords, purgeTextBodies, purgeWebhookRecords, demoResetLine, resetDemoClinic, schema, WebhookRepository, withClinic } from '@attendra/db';
import { type Embedder, indexDocument, LocalEmbedder, OpenAIEmbedder } from '@attendra/knowledge';
import type { Alerter, Logger } from '@attendra/observability';
import { deliver, type GuardOptions, payloadOf, type Resolver } from '@attendra/webhooks';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import OpenAI from 'openai';
import type { Job, PgBoss } from 'pg-boss';
import { type FallbackEntry, fallbackEntry, formatBalance, type SmsSender, smsStatusUrl, type SpendTrigger, type TwilioBalance, type TwilioBalanceReading, type TwilioFallback, TwilioMessenger, type TwilioSpendAlerts } from '@attendra/telephony';
import { CallJob, DeliveryJob, DocumentJob, ensureQueues, HandoverJob, jobId, QUEUES, type RemindersJob, RequestJob, SmsStatusJob, WEBHOOK_RETRY, WebhookEventJob } from './queue';
import { JobError, LocalSummariser, ModelSummariser, SummaryCutOff, SummaryQuotaUsedUp, type Summariser } from './summarise';

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
  /** The Twilio balance, read every hour: under `alertUnder` (dollars) it pages, as calls and texts stop at $0. */
  balance?: { client: Pick<TwilioBalance, 'read'>; alertUnder: number };
}

/** What a summary that OpenAI refused for money says (openai_quota pages, like the voice service's). */
export const SUMMARY_QUOTA_TEXT = 'OpenAI refused a call summary: the credit or quota is used up. Summaries and calls fail until it is topped up.';

/** A low balance that stays low is said again once a day, not every hour. */
export const BALANCE_REMIND_MS = 24 * 3_600_000;

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
export const quiet = inQuietHours;

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
  /** The balance check's memory: since when it is low, when that was last said, when an unread balance was last said. */
  const money: { lowSince: number | null; lowSaidAt: number; unreadAt: number | null } = { lowSince: null, lowSaidAt: 0, unreadAt: null };
  /** Calls whose summary last failed because OpenAI's credit or quota was used up: their dead letter says so (RPT-slack-alerts-2). */
  const quotaFailed = new Set<string>();
  return {
    /**
     * A job that failed every retry: logged with ids only, and said in Slack. A summary that failed for OpenAI's quota
     * says openai_quota again, not "a background job gave up", so the cause is what pages (RPT-slack-alerts-2).
     */
    async deadLetter(data: Record<string, unknown>) {
      d.log.error({ clinic_id: data.clinicId, call_id: data.callId }, 'a job failed every retry and was dead-lettered');
      const where = data.clinicId ? { clinicId: String(data.clinicId), callId: typeof data.callId === 'string' ? data.callId : undefined } : undefined;
      if (typeof data.callId === 'string' && quotaFailed.delete(data.callId)) {
        d.alerts?.alert('openai_quota', `${SUMMARY_QUOTA_TEXT} This call's summary gave up after its retries: it is written when the job runs again.`, where);
        return;
      }
      d.alerts?.alert('job_failed', 'A background job gave up after its retries: a summary, a text or a webhook was not done.', where);
    },

    /** A closed call: queue what every closed call needs, once each. */
    async callCompleted(job: CallJob) {
      const data = CallJob.parse(job);
      await d.boss.send(QUEUES.summariseCall, data, { id: jobId(QUEUES.summariseCall, data.callId) });
      // a visit booked or moved on the call gets its reminder now if it is inside the clinic's hours before it
      await d.boss.send(QUEUES.appointmentReminders, { clinicId: data.clinicId, key: `call|${data.callId}` }, { id: jobId(QUEUES.appointmentReminders, `${data.clinicId}|call|${data.callId}`) });
      const facts = await callFacts(d.db, data.clinicId, data.callId);
      if (facts?.endedAt) await emit(data.clinicId, { type: 'call.completed', key: data.callId, occurredAt: new Date(facts.endedAt), data: facts });
    },

    async summariseCall(job: CallJob): Promise<'saved' | 'exists' | 'gone'> {
      const { clinicId, callId } = CallJob.parse(job);
      const call = await summaries.forSummary(clinicId, callId);
      if (call === null) return 'gone'; // deleted, or never belonged to this clinic
      if (call === 'done') return 'exists';
      if (call === 'not_closed') throw new JobError('call_not_closed');
      // a cut-off answer is the same on every try: the summary from the call's facts instead, never no summary at all
      let model = d.summariser.model;
      const summary = await d.summariser.summarise(call).catch(async (err: unknown) => {
        // no credit: said at once as what it is (it pages), and the queue still tries again later
        if (err instanceof SummaryQuotaUsedUp) {
          quotaFailed.add(callId);
          d.alerts?.alert('openai_quota', SUMMARY_QUOTA_TEXT, { clinicId, callId });
          throw err;
        }
        if (!(err instanceof SummaryCutOff)) throw err;
        model = 'local (model output cut off)';
        d.log.warn({ call_id: callId, model: d.summariser.model }, 'the summary model\'s answer was cut off: the summary from the call\'s facts is saved instead');
        return new LocalSummariser().summarise(call);
      });
      quotaFailed.delete(callId);
      const saved = await summaries.save(clinicId, callId, summary, model);
      d.log.info({ call_id: callId, model, needs_review: summary.needsReview }, 'call summarised');
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
        if (task.created) await emit(clinicId, { type: 'request.created', key: task.id, data: { requestId: task.id, number: task.number, type: 'follow_up', patientId: call.patientId, callId } });
      }
      // an emergency is a check on the caller, not a callback: always in the team's queue, urgent, even when they said no to a callback
      // one urgent item per call: an urgent request the assistant already took on the call is that check. Marked as from
      // an emergency call (REQ-2), so Requests labels it and links the call
      if (saved === 'saved' && call.emergency && !call.tasks.some((t) => t.urgent)) {
        const task = await tasks.create(clinicId, {
          type: 'follow_up', callId, patientId: call.patientId, idempotencyKey: `emergency:${callId}`, urgent: true, origin: 'emergency',
          details: {
            reason: 'Emergency language on the call. Check on the caller as your protocol says.',
            ...(summary.followUp ? { suggested: summary.followUp } : {}),
            ...(call.fromNumber ? { callback_number: call.fromNumber } : {}),
          },
        });
        if (task.created) await emit(clinicId, { type: 'request.created', key: task.id, data: { requestId: task.id, number: task.number, type: 'follow_up', patientId: call.patientId, callId } });
      }
      return saved;
    },

    /** Transcripts, summaries, call actions and webhook events past each clinic's retention period, and call events past 7 days. Counts are audited, never content. */
    async purgeRetention() {
      const results: { clinicId: string; transcriptLines: number; summaries: number; callActions: number; webhookEvents: number; webhookAttempts: number; textBodies: number; callEvents: number }[] = [];
      // the per-call event log is kept a week, whatever the clinic's own retention (foundation A)
      const eventsBefore = new Date(now().getTime() - CALL_EVENTS_RETENTION_DAYS * 86_400_000);
      for (const clinic of await allClinics(d.db)) {
        const parsed = ClinicConfig.safeParse(clinic.config);
        const days = parsed.success ? parsed.data.retentionDays : 2555;
        const before = new Date(now().getTime() - days * 86_400_000);
        const counts = await purgeCallRecords(d.db, clinic.id, before);
        const webhooks = await purgeWebhookRecords(d.db, clinic.id, before);
        // the words of the texts go on the same day as the transcripts; the texts' rows stay
        const texts = await purgeTextBodies(d.db, clinic.id, before);
        const events = await purgeCallEvents(d.db, clinic.id, eventsBefore);
        results.push({ clinicId: clinic.id, ...counts, ...webhooks, ...texts, ...events });
      }
      const total = (k: 'transcriptLines' | 'summaries' | 'callActions' | 'webhookEvents' | 'webhookAttempts' | 'textBodies' | 'callEvents') => results.reduce((n, r) => n + r[k], 0);
      d.log.info({ clinics: results.length, transcript_lines: total('transcriptLines'), summaries: total('summaries'), call_actions: total('callActions'), webhook_events: total('webhookEvents'), webhook_attempts: total('webhookAttempts'), text_bodies: total('textBodies'), call_events: total('callEvents') }, 'retention purge done');
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

    /**
     * The last day's calls in one Slack message, every morning: how many, how soon callers heard the assistant, and
     * the empty lines, stalls, answers past the limit and drops, with the clinics they happened at. Counts and ids only.
     */
    /**
     * The demo clinics' nightly reset (2026-11-16): each one whose 03:30 (its own clock) has come since its last reset
     * (or its baseline) is put back to its baseline, and Slack hears it with counts only. One with a call going is left
     * for the next run, ten minutes later; one with no baseline yet is skipped. Never touches a clinic that is not one.
     */
    async demoReset(): Promise<{ clinicId: string; result: string }[]> {
      const at = now();
      const out: { clinicId: string; result: string }[] = [];
      for (const c of await demoClinics(d.db)) {
        if (!c.hasBaseline) { out.push({ clinicId: c.clinicId, result: 'no_baseline' }); continue; }
        if (c.lastResetAt && c.lastResetAt.getTime() >= demoResetDue(c.timezone, at).getTime()) { out.push({ clinicId: c.clinicId, result: 'not_due' }); continue; }
        const r = await resetDemoClinic(d.db, d.cipher, c.clinicId, DEMO_NIGHTLY_ACTOR, at);
        if (!r.ok) {
          d.log.info({ clinic_id: c.clinicId, result: r.error }, 'demo clinic reset waits');
          out.push({ clinicId: c.clinicId, result: r.error });
          continue;
        }
        d.log.info({ clinic_id: c.clinicId, counts: r.counts }, 'demo clinic reset');
        d.alerts?.note(`Demo clinic reset (nightly), clinic ${c.clinicId}: ${demoResetLine(r.counts)}.`);
        out.push({ clinicId: c.clinicId, result: 'reset' });
      }
      return out;
    },

    async dailyDigest() {
      // the clinics by name, as the team knows them; the id when a clinic has none
      const names = new Map((await allClinics(d.db)).flatMap((c) => { const n = configName(c.config); return n ? [[c.id, n] as const] : []; }));
      const text = dailyDigest(await callsForDigest(d.db, new Date(now().getTime() - 86_400_000)), 24, names);
      d.alerts?.note(text);
      d.log.info({}, 'daily digest sent');
      return text;
    },

    /**
     * The Twilio balance against its line, every hour. Under it pages at once (twilio_balance_low), then once a day
     * while it stays low; back above, it says so. A balance that cannot be read is said once a day, never paged.
     */
    async moneyCheck() {
      const b = d.balance;
      if (!b) return null;
      let reading: TwilioBalanceReading;
      try {
        reading = await b.client.read();
      } catch (err) {
        d.log.warn({ err: { message: (err as Error).message } }, 'twilio balance not read');
        if (money.unreadAt === null || now().getTime() - money.unreadAt >= BALANCE_REMIND_MS) {
          money.unreadAt = now().getTime();
          d.alerts?.alert('twilio_balance_unread', `The Twilio balance could not be read (${(err as Error).message.slice(0, 80)}): a low balance would not be said.`);
        }
        return null;
      }
      money.unreadAt = null;
      const low = reading.balance < b.alertUnder;
      d.log.info({ balance: reading.balance, currency: reading.currency, alert_under: b.alertUnder, low }, 'twilio balance read');
      if (low && (money.lowSince === null || now().getTime() - money.lowSaidAt >= BALANCE_REMIND_MS)) {
        money.lowSince ??= now().getTime();
        money.lowSaidAt = now().getTime();
        d.alerts?.alert('twilio_balance_low', `Twilio balance ${formatBalance(reading)}, under $${b.alertUnder}. Calls and texts stop at $0.`);
      } else if (!low && money.lowSince !== null) {
        money.lowSince = null;
        d.alerts?.resolved('twilio_balance_low', `Twilio balance ${formatBalance(reading)}.`);
      }
      return reading;
    },

    /** Team invitations nobody answered in 7 days: closed, with an audit row in the inviting team's clinics. Reading them never writes. */
    async lapseInvitations() {
      const lapsed = await lapseInvitations(d.db, now());
      if (lapsed) d.log.info({ lapsed }, 'invitations lapsed');
      return lapsed;
    },

    /**
     * Reminder texts (core reminderDecision): every 10 minutes, and at once after a desk booking or a call. A visit gets
     * its reminder as soon as it is inside the clinic's "hours before the visit", for any booking whose owner said yes
     * to texts, while it is still more than an hour away; when one cannot go (no consent, no number, quiet hours,
     * booked under an hour before), the reason is kept on the visit (appointments.reminder_skip) for the visit panel.
     * Before 2026-11-17 it sent only for visits 2 to 3 hours away at a setting of 2, so a visit booked, or reminders
     * turned on, after that window opened was never texted, and nothing said why (texts polish TX0).
     */
    async appointmentReminders(job?: { clinicId?: string } | null) {
      const at = now();
      let sent = 0;
      let skipped = 0;
      for (const row of await allClinics(d.db)) {
        if (job?.clinicId && row.id !== job.clinicId) continue;
        // a closed clinic (a location removed) texts nobody
        if (row.closedAt) continue;
        const parsed = ClinicConfig.safeParse(row.config);
        if (!parsed.success) continue;
        const config = parsed.data;
        const r = textingOf(config).reminders;
        if (!r.enabled) continue;
        const quietNow = quiet(localParts(at, config.timezone).minutes, r.quietFrom, r.quietTo);
        const clinicId = config.id;
        // every booked visit still to come, inside the clinic's hours before it, with no reminder yet
        const due = await withClinic(d.db, clinicId, (tx) => tx.select({ a: schema.appointments, p: schema.patients, language: schema.calls.language })
          .from(schema.appointments)
          .innerJoin(schema.patients, eq(schema.patients.id, schema.appointments.patientId))
          .leftJoin(schema.calls, eq(schema.calls.id, schema.appointments.createdByCallId))
          .where(and(
            eq(schema.appointments.clinicId, clinicId), eq(schema.appointments.status, 'booked'), isNull(schema.appointments.reminderSentAt),
            gt(schema.appointments.startsAt, at), lte(schema.appointments.startsAt, new Date(at.getTime() + r.hoursBefore * 3_600_000)),
          )));
        if (!due.length) continue;
        const messenger = new TwilioMessenger(d.db, d.cipher, d.texts ?? null, () => config.phoneNumbers[0]!, {
          actor: 'worker', dailyCap: d.sms?.dailyCap, monthlyCap: d.sms?.monthlyCap, alerts: d.alerts, log: d.log,
          statusCallback: d.sms?.publicUrl ? (id) => smsStatusUrl(d.sms!.publicUrl!, id) : undefined,
        });
        for (const { a, p, language } of due) {
          const decision = reminderDecision({
            now: at, startsAt: a.startsAt, bookedAt: a.createdAt, hoursBefore: r.hoursBefore, quietNow,
            consent: !!p.smsConsentAt && !p.deletedAt, phone: !!p.phoneEnc, kept: (a.reminderSkip as ReminderSkip | null) ?? null,
          });
          if (decision.action === 'later') continue;
          if (decision.action === 'skip') {
            // the reason kept on the visit (and audited) when it changes; reminder_sent_at stays empty, so a reply of C
            // never confirms a visit that had no reminder
            if (a.reminderSkip !== decision.reason) {
              await withClinic(d.db, clinicId, async (tx) => {
                const changed = await tx.update(schema.appointments).set({ reminderSkip: decision.reason, reminderSkipAt: at })
                  .where(and(eq(schema.appointments.id, a.id), isNull(schema.appointments.reminderSentAt))).returning({ id: schema.appointments.id });
                if (changed.length) await tx.insert(schema.auditLogs).values({ clinicId, actor: 'worker', action: `appointment.reminder.skipped.${decision.reason}`, entity: 'appointment', entityId: a.id });
              });
              skipped++;
            }
            continue;
          }
          const claimed = await withClinic(d.db, clinicId, (tx) => tx.update(schema.appointments).set({ reminderSentAt: now(), reminderSkip: null, reminderSkipAt: null })
            .where(and(eq(schema.appointments.id, a.id), isNull(schema.appointments.reminderSentAt))).returning({ id: schema.appointments.id }));
          if (!claimed.length) continue;
          const lang = config.languages.includes(language as never) ? (language as typeof config.primaryLanguage) : config.primaryLanguage;
          const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
          // "Hi Sam, a reminder of Scout's check-up with Dr. Ruiz": the owner and the pet by name; a person by
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
              // a vet as "Dr. Wren Abara": the title kept apart from the name (db:vet-titles) is said, as on the call (SMALL-1)
              ...(provider && provider.kind !== 'room' ? { provider: providerName(provider, lang) } : {}),
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
      if (skipped) d.log.info({ skipped }, 'reminders not sent: the reason is kept on each visit');
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
      if (!found || found.task.type !== 'refill' || !isRefillDecision(found.task.outcome)) return 'skipped';
      const details = JSON.parse(d.cipher.decrypt(found.task.detailsEnc, phiContext(clinicId, 'tasks.details'))) as Record<string, string>;
      // what the team decided, in one text each (core refillText, the rule the outcome labels and Settings > Texting say):
      // ready to pick up, sent to the pharmacy (named, never the medicine), or please call us; none to a caller who did
      // not say yes, or with no pharmacy to name, and the request's history says so (note 2026-11-16 RF3)
      const plan = refillText(found.task.outcome, { type: found.task.type, fromCall: !!found.task.callId, details });
      if (!plan) return 'skipped';
      if ('none' in plan) {
        await withClinic(d.db, clinicId, (tx) => tx.insert(schema.auditLogs).values({ clinicId, actor: 'worker', action: `task.text.none.${plan.none}`, entity: 'task', entityId: taskId }));
        return 'skipped';
      }
      const { template, pharmacy } = plan;
      const { config } = found;
      const language = config.languages.includes(found.language as never) ? (found.language as typeof config.primaryLanguage) : config.primaryLanguage;
      // with the clinic's texting off (its registration not approved), the text is recorded as not sent, and why
      const messenger = new TwilioMessenger(d.db, d.cipher, textingOf(config).enabled ? d.texts ?? null : null, () => config.phoneNumbers[0]!, {
        actor: 'worker', dailyCap: d.sms?.dailyCap, monthlyCap: d.sms?.monthlyCap, alerts: d.alerts, log: d.log,
        statusCallback: d.sms?.publicUrl ? (id) => smsStatusUrl(d.sms!.publicUrl!, id) : undefined,
      });
      // a refusal (texts off, opted out, no number) is kept on the request for staff to see
      const result = await messenger.sendTemplate(clinicId, {
        to: details.callback_number ?? '', template,
        // the pet by name when the request has it ("Scout's request is ready"); never the medicine
        vars: { clinic: config.name, clinicPhone: callUsNumber(config), ref: `R-${found.task.number}`, ...(details.pet_name ? { pet: details.pet_name } : {}), ...(template === 'refill_sent' ? { pharmacy: pharmacy! } : {}) },
        idempotencyKey: template === 'request_ready' ? `request-ready:${taskId}` : `${template}:${taskId}`, language, kind: 'auto',
        about: { callId: found.task.callId, patientId: found.task.patientId, taskId },
      });
      if (result.status !== 'not_sent') return 'sent';
      if (result.reason === 'carrier') throw new JobError('sms_failed'); // the carrier may take it on a retry
      if (result.reason === 'texting_off') d.log.info({ clinic_id: clinicId, task_id: taskId, template }, 'texts are off: no refill text sent');
      return result.reason === 'texting_off' ? 'off' : 'not_sent';
    },

    /**
     * A visit handed to another vet when its vet was removed (note 32), after the team said yes to
     * texting the owners: one text, at the same day and time, naming the vet it is now with and never
     * the reason for the visit. Only to an owner who agreed to texts, with a number on file, while the
     * clinic's texting is on (a clinic with no number of its own, a test clinic, texts nobody), and only
     * while the visit is still booked with that vet and still ahead: a visit moved again since is left
     * alone. A number that replied STOP is refused by the messenger, which records why.
     */
    async visitHandedOver(job: HandoverJob): Promise<'sent' | 'off' | 'not_sent' | 'skipped'> {
      const { clinicId, appointmentId, providerId } = HandoverJob.parse(job);
      const found = await withClinic(d.db, clinicId, async (tx) => {
        const [row] = await tx.select({ a: schema.appointments, p: schema.patients, language: schema.calls.language })
          .from(schema.appointments)
          .innerJoin(schema.patients, eq(schema.patients.id, schema.appointments.patientId))
          .leftJoin(schema.calls, eq(schema.calls.id, schema.appointments.createdByCallId))
          .where(and(eq(schema.appointments.clinicId, clinicId), eq(schema.appointments.id, appointmentId)));
        const [clinic] = await tx.select({ config: schema.clinics.config, closedAt: schema.clinics.closedAt }).from(schema.clinics).where(eq(schema.clinics.id, clinicId));
        return row && clinic ? { ...row, clinic } : null;
      });
      if (!found || found.clinic.closedAt) return 'skipped';
      const { a, p, language } = found;
      if (a.status !== 'booked' || a.providerId !== providerId || a.startsAt.getTime() <= now().getTime()) return 'skipped';
      if (!p.smsConsentAt || !p.phoneEnc || p.deletedAt) return 'skipped';
      const parsed = ClinicConfig.safeParse(found.clinic.config);
      if (!parsed.success) return 'skipped';
      const config = parsed.data;
      const messenger = new TwilioMessenger(d.db, d.cipher, textingOf(config).enabled ? d.texts ?? null : null, () => config.phoneNumbers[0]!, {
        actor: 'worker', dailyCap: d.sms?.dailyCap, monthlyCap: d.sms?.monthlyCap, alerts: d.alerts, log: d.log,
        statusCallback: d.sms?.publicUrl ? (id) => smsStatusUrl(d.sms!.publicUrl!, id) : undefined,
      });
      const lang = config.languages.includes(language as never) ? (language as typeof config.primaryLanguage) : config.primaryLanguage;
      const ctx = (col: string) => phiContext(clinicId, `patients.${col}`);
      const pets = config.industry === 'vet';
      const firstName = d.cipher.decrypt(p.firstNameEnc, ctx('first_name'));
      const owner = pets && p.guardianNameEnc ? d.cipher.decrypt(p.guardianNameEnc, ctx('guardian_name')).trim().split(/\s+/)[0] : '';
      const provider = config.providers.find((x) => x.id === providerId);
      const visit = pets ? config.visitTypes.find((x) => x.id === a.visitTypeId) : undefined;
      if (!provider) return 'skipped';
      const result = await messenger.sendTemplate(clinicId, {
        to: d.cipher.decrypt(p.phoneEnc, ctx('phone')), template: 'vet_changed', language: lang, kind: 'auto',
        vars: {
          clinic: config.name, when: speakSlot(a.startsAt, config.timezone, lang), clinicPhone: callUsNumber(config), provider: providerName(provider, lang),
          ...(pets ? { pet: firstName, ...(owner ? { name: owner } : {}) } : { name: firstName }),
          ...(visit ? { visit: localName(visit, lang).toLowerCase() } : {}),
        },
        idempotencyKey: `vet-changed:${appointmentId}:${providerId}`, about: { patientId: p.id, appointmentId },
      });
      if (result.status !== 'not_sent') return 'sent';
      if (result.reason === 'carrier') throw new JobError('sms_failed');
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
          if ((next === 'failed' || next === 'undelivered') && errorCode !== '21610') d.alerts?.alert('text_failed', `A text was not delivered (Twilio error ${errorCode ?? 'none given'}).`, { clinicId });
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
  // on pg-boss's connection: production runs it as the owner, which may create the view
  await ensureWorkerJobsView((text) => d.boss.getDb().executeSql(text));
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
  await d.boss.work<HandoverJob>(QUEUES.visitHandedOver, poll, each((data) => h.visitHandedOver(data)));
  await d.boss.work<Partial<RemindersJob> | null>(QUEUES.appointmentReminders, each((data) => h.appointmentReminders(data)));
  await d.boss.work(QUEUES.lapseInvitations, each(async () => { await h.lapseInvitations(); }));
  await d.boss.work(QUEUES.dailyDigest, each(async () => { await h.dailyDigest(); }));
  await d.boss.work(QUEUES.moneyCheck, each(async () => { await h.moneyCheck(); }));
  await d.boss.work(QUEUES.fallbackSync, each(async () => { await h.fallbackSync(); }));
  await d.boss.work(QUEUES.demoReset, each(async () => { await h.demoReset(); }));
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
  await d.boss.work<Record<string, unknown>>(QUEUES.deadLetter, each((data) => h.deadLetter(data)));
  // 03:00 UTC every day
  if (d.schedulePurge !== false) {
    await d.boss.schedule(QUEUES.purgeRetention, '0 3 * * *');
    await d.boss.schedule(QUEUES.appointmentReminders, '*/10 * * * *');
    await d.boss.schedule(QUEUES.lapseInvitations, '7 * * * *');
    // 03:10 UTC: the morning in the team's time zone, after the night's calls in the clinics' (and before the 03:30 backup)
    await d.boss.schedule(QUEUES.dailyDigest, '10 3 * * *');
    // every hour, at :17, away from the other hourly jobs
    if (d.balance) await d.boss.schedule(QUEUES.moneyCheck, '17 * * * *');
    if (d.fallback) await d.boss.schedule(QUEUES.fallbackSync, '*/10 * * * *');
    // every 10 minutes, at :03: a demo clinic is reset at the first run after 03:30 on its own clock
    await d.boss.schedule(QUEUES.demoReset, '3-59/10 * * * *');
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
