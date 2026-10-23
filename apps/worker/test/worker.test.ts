import { DEMO_CLINIC, Texting, zonedInstant } from '@attendra/core';
import { CallRepository, CallSummaryRepository, clinicById, createPhiCipher, FrontDeskRepository, KnowledgeRepository, PostgresPatientDirectory, PostgresTaskQueue, phiContext, purgeCallRecords, purgeWebhookRecords, saveClinic, schema, seedDemo, WebhookRepository, withClinic, workerJobs } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { and, eq, sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bossQueue, createBoss, jobId, QUEUES } from '../src/queue';
import { handlers, quiet, startWorker } from '../src/runtime';
import { JobError, LocalSummariser, type Summariser } from '../src/summarise';

const cipher = createPhiCipher(TEST_DATA_KEY);
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let calls: CallRepository;
let n = 0;

/** A finished call with a line or two of transcript, as the voice service leaves it. */
async function closedCall(clinicId = DEMO_CLINIC.id, opts: { closed?: boolean; emergency?: boolean } = {}) {
  const callId = await calls.open(clinicId, `live_worker_${++n}`, '+13035550147');
  await calls.appendSegment(clinicId, callId, { speaker: 'caller', text: 'Hi, this is Maria Delgado, born March 4th 1985.', startMs: 0, endMs: 900 });
  await calls.recordAction(clinicId, callId, { tool: 'verify_caller', argsRedacted: ['full_name', 'date_of_birth'], result: { ok: true, verified: true }, taskRevision: 1 });
  if (opts.closed !== false) await calls.close(clinicId, callId, { reason: 'caller_hangup', voiceSeconds: 42, outcome: opts.emergency ? 'emergency' : 'info', emergency: !!opts.emergency });
  return callId;
}

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 200));
  }
};
const summaryOf = (clinicId: string, callId: string) =>
  withClinic(t.db, clinicId, async (tx) => (await tx.select().from(schema.callSummaries).where(eq(schema.callSummaries.callId, callId)))[0] ?? null);
const audits = (clinicId: string, action: string) =>
  withClinic(t.db, clinicId, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.clinicId, clinicId), eq(schema.auditLogs.action, action))));

const lines = async (callId: string) => ((await t.db.execute(sql`select count(*)::int as n from call_segments where call_id = ${callId}`)).rows[0] as { n: number }).n;

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  await saveClinic(t.db, 'org_other', OTHER);
  calls = new CallRepository(t.db, cipher);
});
afterAll(() => t.close());

describe('summarising a call', () => {
  const h = () => handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log });

  it('stores the summary encrypted, audits the read and the write, and does it once', async () => {
    const callId = await closedCall();
    expect(await h().summariseCall({ clinicId: DEMO_CLINIC.id, callId })).toBe('saved');
    const row = await summaryOf(DEMO_CLINIC.id, callId);
    expect(row).toMatchObject({ intent: 'other', sentiment: 'calm', needsReview: false, model: 'local' });
    expect(row!.bodyEnc).not.toContain('verified'); // encrypted, not JSON in clear
    expect(await h().summariseCall({ clinicId: DEMO_CLINIC.id, callId })).toBe('exists');
    const actions = (await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.callId, callId), eq(schema.auditLogs.actor, 'worker'))))).map((a) => `${a.actor} ${a.action}`);
    expect(actions).toEqual(['worker call.transcript.read', 'worker call.summary.written']);
  });

  it('waits for a call that has not closed, and ignores one from another clinic', async () => {
    const open = await closedCall(DEMO_CLINIC.id, { closed: false });
    await expect(h().summariseCall({ clinicId: DEMO_CLINIC.id, callId: open })).rejects.toThrow('call_not_closed');
    const theirs = await closedCall(OTHER.id);
    expect(await h().summariseCall({ clinicId: DEMO_CLINIC.id, callId: theirs })).toBe('gone');
    expect(await summaryOf(OTHER.id, theirs)).toBeNull();
  });

  it('shows the summary on the call page, and the review flag in the list until someone reviews it', async () => {
    const callId = await closedCall(DEMO_CLINIC.id, { emergency: true });
    await h().summariseCall({ clinicId: DEMO_CLINIC.id, callId });
    const desk = new FrontDeskRepository(t.db, cipher);
    const call = await desk.getCall(DEMO_CLINIC.id, callId, 'u_ana');
    expect(call!.summary).toMatchObject({ intent: 'emergency', needsReview: true, reviewReason: 'Emergency language on the call.', model: 'local' });
    const flagged = await desk.listCalls(DEMO_CLINIC.id, { limit: 50, needsReview: true });
    expect(flagged.map((c) => c.id)).toContain(callId);
    expect(flagged.every((c) => c.needsReview)).toBe(true);
    expect(await new CallSummaryRepository(t.db, cipher).markReviewed(DEMO_CLINIC.id, callId, 'u_ana')).toBe('reviewed');
    expect((await desk.listCalls(DEMO_CLINIC.id, { limit: 50, needsReview: true })).map((c) => c.id)).not.toContain(callId);
    expect((await audits(DEMO_CLINIC.id, 'call.summary.reviewed')).map((a) => a.entityId)).toContain(callId);
  });
});

describe('follow-up requests', () => {
  const flagging: Summariser = {
    model: 'stub',
    summarise: async () => ({ summary: 'The caller wanted a visit for their son. Nothing was booked.', intent: 'book', sentiment: 'frustrated', needsReview: true, reviewReason: 'The caller became frustrated and nothing was booked.', followUp: 'Call the caller to book the visit.' }),
  };
  const h = () => handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: flagging, log });
  const tasksOf = (callId: string) => withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.tasks).where(eq(schema.tasks.callId, callId)));

  it('opens one follow-up request for a flagged call that settled nothing, and closing it reviews the call', async () => {
    const callId = await closedCall();
    await h().summariseCall({ clinicId: DEMO_CLINIC.id, callId });
    await h().summariseCall({ clinicId: DEMO_CLINIC.id, callId });
    const opened = await tasksOf(callId);
    expect(opened.map((x) => x.type)).toEqual(['follow_up']);
    // the number the caller rang from is on the request, so the team can call back (2026-10-23)
    const details = JSON.parse(cipher.decrypt(opened[0]!.detailsEnc, phiContext(DEMO_CLINIC.id, 'tasks.details'))) as Record<string, string>;
    expect(details.callback_number).toBe('+13035550147');
    // and the call shows it to staff
    const shown = await new FrontDeskRepository(t.db, cipher).getCall(DEMO_CLINIC.id, callId, 'u_ana');
    expect(shown!.callerNumber).toBe('+13035550147');
    // a second call from that number knows the first, and the read is audited
    const again = await calls.open(DEMO_CLINIC.id, `live_worker_${++n}`, '(303) 555-0147');
    const history = await new CallSummaryRepository(t.db, cipher).historyFor(DEMO_CLINIC.id, '+13035550147', again);
    expect(history).toContain('The caller wanted a visit for their son');
    expect(history).toContain('Still open for the team: follow up');
    expect((await audits(DEMO_CLINIC.id, 'call.history.read')).map((a) => a.entityId)).toContain(again);
    expect(await new CallSummaryRepository(t.db, cipher).historyFor(DEMO_CLINIC.id, '+13035550199', again)).toBeNull();
    const desk = new FrontDeskRepository(t.db, cipher);
    expect(await desk.completeTask(DEMO_CLINIC.id, opened[0]!.id, 'u_ana', 'called_back')).toBe('done');
    expect((await summaryOf(DEMO_CLINIC.id, callId))!.reviewedAt).not.toBeNull();
  });

  it('opens none for a booked call, an emergency, or a call that already made a request', async () => {
    const booked = await calls.open(DEMO_CLINIC.id, `live_worker_${++n}`, '+13035550147');
    await calls.close(DEMO_CLINIC.id, booked, { reason: 'caller_hangup', voiceSeconds: 60, outcome: 'booked', emergency: false });
    const emergency = await closedCall(DEMO_CLINIC.id, { emergency: true });
    for (const callId of [booked, emergency]) await h().summariseCall({ clinicId: DEMO_CLINIC.id, callId });
    expect(await tasksOf(booked)).toEqual([]);
    expect(await tasksOf(emergency)).toEqual([]);
  });
});

describe('the retention purge', () => {
  it('deletes transcripts and summaries past each clinic\'s retention, and audits how many, never what', async () => {
    await saveClinic(t.db, 'org_other', { ...OTHER, retentionDays: 30 } as typeof OTHER);
    const old = await closedCall(OTHER.id);
    const recent = await closedCall(OTHER.id);
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, now: () => new Date() });
    await h.summariseCall({ clinicId: OTHER.id, callId: old });
    await t.db.execute(sql`update calls set started_at = now() - interval '40 days' where id = ${old}`);

    await calls.recordAction(OTHER.id, old, { tool: 'get_clinic_info', argsRedacted: ['question'], result: { ok: true }, taskRevision: 1 });
    await calls.recordAction(OTHER.id, recent, { tool: 'get_clinic_info', argsRedacted: ['question'], result: { ok: true }, taskRevision: 1 });

    const actionsOf = async (id: string) => ((await t.db.execute(sql`select count(*)::int as n from call_actions where call_id = ${id}`)).rows[0] as { n: number }).n;
    const oldActions = await actionsOf(old);
    const recentActions = await actionsOf(recent);

    const results = await h.purgeRetention();
    expect(results.find((r) => r.clinicId === OTHER.id)).toMatchObject({ clinicId: OTHER.id, transcriptLines: 1, summaries: 1, callActions: oldActions });
    expect(results.find((r) => r.clinicId === DEMO_CLINIC.id)).toMatchObject({ transcriptLines: 0, summaries: 0, callActions: 0 }); // 2555 days by default
    expect(await actionsOf(old)).toBe(0);
    expect(await actionsOf(recent)).toBe(recentActions);
    expect(await lines(old)).toBe(0);
    expect(await lines(recent)).toBe(1);
    const audit = (await audits(OTHER.id, 'retention.purged')).find((r) => 'transcriptLines' in (r.counts as object));
    expect(audit).toMatchObject({ actor: 'worker', entity: 'clinic', counts: { transcriptLines: 1, summaries: 1, callActions: oldActions } });
  });

  it('deletes webhook events and their delivery attempts on the same retention, in batches', async () => {
    await saveClinic(t.db, 'org_other', { ...OTHER, retentionDays: 30 } as typeof OTHER);
    const hooks = new WebhookRepository(t.db, cipher);
    const endpoint = await hooks.create(OTHER.id, { url: 'https://example.com/hook', description: '', events: ['call.completed'], secret: 'whsec_test', userId: 'u_otto' });
    const event = async (id: string, days: number) => {
      await hooks.record({ id, clinicId: OTHER.id, type: 'call.completed', data: {}, occurredAt: new Date().toISOString() });
      await hooks.logAttempt(OTHER.id, { endpointId: endpoint, eventId: id, kind: 'automatic', attempt: 1, statusCode: 200, durationMs: 5, error: null });
      await t.db.execute(sql`update webhook_events set created_at = now() - make_interval(days => ${days}) where id = ${id}`);
    };
    for (const id of ['evt_old_1', 'evt_old_2', 'evt_old_3']) await event(id, 40);
    await event('evt_recent', 5);
    const seen = new Set((await audits(OTHER.id, 'retention.purged')).map((r) => r.id));

    expect(await purgeWebhookRecords(t.db, OTHER.id, new Date(Date.now() - 30 * 86_400_000), 2)).toEqual({ webhookEvents: 3, webhookAttempts: 3 });
    expect(await hooks.event(OTHER.id, 'evt_old_1')).toBeNull();
    expect(await hooks.event(OTHER.id, 'evt_recent')).not.toBeNull();
    expect(await hooks.attempts(OTHER.id, endpoint)).toHaveLength(1);
    const rows = (await audits(OTHER.id, 'retention.purged')).filter((r) => !seen.has(r.id));
    expect(rows.map((r) => (r.counts as { webhookEvents: number }).webhookEvents).sort()).toEqual([1, 2]);

    await event('evt_old_4', 40);
    const results = await handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, now: () => new Date() }).purgeRetention();
    expect(results.find((r) => r.clinicId === OTHER.id)).toMatchObject({ webhookEvents: 1, webhookAttempts: 1 });
  });

  it('works through old calls in batches, each its own transaction', async () => {
    const ids = [await closedCall(OTHER.id), await closedCall(OTHER.id), await closedCall(OTHER.id)];
    await t.db.execute(sql`update calls set started_at = now() - interval '50 days' where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    const seen = new Set((await audits(OTHER.id, 'retention.purged')).map((r) => r.id));
    const counts = await purgeCallRecords(t.db, OTHER.id, new Date(Date.now() - 30 * 86_400_000), 2);
    expect(counts.transcriptLines).toBe(3);
    for (const id of ids) expect(await lines(id)).toBe(0);
    // one counts row per batch, written with that batch's deletes
    const rows = (await audits(OTHER.id, 'retention.purged')).filter((r) => !seen.has(r.id));
    expect(rows.map((r) => (r.counts as { transcriptLines: number }).transcriptLines).sort()).toEqual([1, 2]);
  });
});

describe('text delivery status', () => {
  it('records a status for a text it sent, by Twilio\'s id, and nothing for one it did not', async () => {
    const sid = `SM${'a'.repeat(32)}`;
    await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.insert(schema.smsMessages).values({ clinicId: DEMO_CLINIC.id, template: 'booking_confirmed', toHash: 'h', idempotencyKey: 'k-sms', status: 'sent', providerSid: sid }));
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log });
    expect(await h.smsStatus({ clinicId: DEMO_CLINIC.id, messageSid: sid, status: 'delivered' })).toBe('updated');
    // every status Twilio sends for an outbound message, not only the common five
    for (const status of ['accepted', 'scheduled', 'sending', 'canceled', 'partially_delivered', 'read'] as const) {
      expect(await h.smsStatus({ clinicId: DEMO_CLINIC.id, messageSid: sid, status })).toBe('updated');
    }
    const [row] = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.smsMessages).where(eq(schema.smsMessages.providerSid, sid)));
    // a late report never moves it backwards
    expect(row).toMatchObject({ status: 'delivered', deliveredAt: expect.any(Date) });
    expect(await h.smsStatus({ clinicId: DEMO_CLINIC.id, messageSid: `SM${'b'.repeat(32)}`, status: 'delivered' })).toBe('unknown');
    await expect(h.smsStatus({ clinicId: DEMO_CLINIC.id, messageSid: 'not-a-sid', status: 'delivered' })).rejects.toThrow();
  });

  it('keeps the carrier\'s error, and a number the carrier says opted out is not texted again', async () => {
    const sid = `SM${'d'.repeat(32)}`;
    await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.insert(schema.smsMessages).values({ clinicId: DEMO_CLINIC.id, template: 'request_ready', toHash: 'h-21610', idempotencyKey: 'k-sms-21610', status: 'sent', providerSid: sid }));
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log });
    expect(await h.smsStatus({ clinicId: DEMO_CLINIC.id, messageSid: sid, status: 'undelivered', errorCode: '21610' })).toBe('updated');
    const rows = await withClinic(t.db, DEMO_CLINIC.id, async (tx) => ({
      text: (await tx.select().from(schema.smsMessages).where(eq(schema.smsMessages.providerSid, sid)))[0],
      opt: (await tx.select().from(schema.smsOptOuts).where(eq(schema.smsOptOuts.toHash, 'h-21610')))[0],
    }));
    expect(rows.text).toMatchObject({ status: 'undelivered', errorCode: '21610', failureReason: 'carrier' });
    expect(rows.opt).toMatchObject({ status: 'opted_out', source: 'carrier' });
  });
});

describe('the worker on pg-boss', () => {
  let boss: PgBoss;
  let failing: false | 'code' | 'raw' = false;
  const flaky: Summariser = {
    model: 'local',
    summarise: async (call) => {
      if (failing === 'code') throw new JobError('summary_model_http_500');
      // an error from a library, whose message quotes patient data
      if (failing === 'raw') throw new Error('duplicate key value violates unique constraint: (Maria Delgado, 1985-03-04)');
      return new LocalSummariser().summarise(call);
    },
  };

  beforeAll(async () => {
    boss = createBoss({ pglite: t.client });
    await boss.start();
    await startWorker({ boss, db: t.db, cipher, summariser: flaky, log, schedulePurge: false, retry: { retryLimit: 1, retryDelay: 1, retryBackoff: false } });
  }, 60_000);
  afterAll(() => boss.stop({ graceful: false }));

  it('summarises a closed call from one call.completed job, however many times it is sent', async () => {
    const callId = await closedCall();
    const queue = bossQueue(boss);
    await queue.callCompleted({ clinicId: DEMO_CLINIC.id, callId });
    await queue.callCompleted({ clinicId: DEMO_CLINIC.id, callId });
    await until(() => summaryOf(DEMO_CLINIC.id, callId));
    const jobs = await workerJobs(t.db, DEMO_CLINIC.id, { callId });
    expect(jobs.filter((j) => j.name === QUEUES.callCompleted)).toHaveLength(1);
    expect(jobs.filter((j) => j.name === QUEUES.summariseCall)).toHaveLength(1);
    expect(jobs.find((j) => j.name === QUEUES.callCompleted)!.id).toBe(jobId(QUEUES.callCompleted, callId));
  });

  it('retries a failing summary, then dead-letters it, with a code the dashboard can show', async () => {
    failing = 'code';
    const callId = await closedCall();
    await bossQueue(boss).callCompleted({ clinicId: DEMO_CLINIC.id, callId });
    const failed = await until(async () => (await workerJobs(t.db, DEMO_CLINIC.id, { callId })).find((j) => j.name === QUEUES.summariseCall && j.state === 'failed'), 30_000);
    expect(failed).toMatchObject({ retryCount: 1, retryLimit: 1, failure: 'summary_model_http_500' });
    await until(async () => (await workerJobs(t.db, DEMO_CLINIC.id, { callId })).find((j) => j.name === QUEUES.deadLetter));
    expect(await summaryOf(DEMO_CLINIC.id, callId)).toBeNull();
    failing = false;
  }, 45_000);

  it('shows a code for an unexpected error, never its message', async () => {
    failing = 'raw';
    const callId = await closedCall();
    await bossQueue(boss).callCompleted({ clinicId: DEMO_CLINIC.id, callId });
    const failed = await until(async () => (await workerJobs(t.db, DEMO_CLINIC.id, { callId })).find((j) => j.name === QUEUES.summariseCall && j.state === 'failed'), 30_000);
    expect(failed.failure).toBe('unexpected_error');
    expect(JSON.stringify(await workerJobs(t.db, DEMO_CLINIC.id))).not.toContain('Delgado');
    failing = false;
  }, 45_000);

  it('indexes an uploaded document once per content, however many times it is sent', async () => {
    const repo = new KnowledgeRepository(t.db);
    const saved = await repo.save(DEMO_CLINIC.id, { title: 'Late arrivals', sourceType: 'text', content: Buffer.from('If you arrive more than 15 minutes late, we may ask you to rebook.'), userId: 'u_ana' });
    const queue = bossQueue(boss);
    await queue.indexDocument({ clinicId: DEMO_CLINIC.id, documentId: saved.id, hash: saved.hash });
    await queue.indexDocument({ clinicId: DEMO_CLINIC.id, documentId: saved.id, hash: saved.hash });
    await until(async () => (await repo.get(DEMO_CLINIC.id, saved.id))?.status === 'ready');
    expect((await workerJobs(t.db, DEMO_CLINIC.id)).filter((j) => j.name === QUEUES.indexDocument)).toHaveLength(1);
    expect((await repo.get(DEMO_CLINIC.id, saved.id))?.chunkCount).toBe(1);
  });

  it('shows each clinic only its own jobs', async () => {
    const theirs = await closedCall(OTHER.id);
    await bossQueue(boss).callCompleted({ clinicId: OTHER.id, callId: theirs });
    await until(() => summaryOf(OTHER.id, theirs));
    expect((await workerJobs(t.db, DEMO_CLINIC.id)).some((j) => j.callId === theirs)).toBe(false);
    expect((await workerJobs(t.db, OTHER.id)).some((j) => j.callId === theirs)).toBe(true);
  });
});

describe('a refill ready to pick up', () => {
  it('texts the number the caller left, once, from the clinic\'s number, without naming the medication', async () => {
    const sent: { from: string; to: string; body: string }[] = [];
    const texts = { send: async (m: { from: string; to: string; body: string }) => { sent.push(m); return { sid: `SM${'a'.repeat(31)}${sent.length}` }; } };
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, texts });
    const queue = new PostgresTaskQueue(t.db, cipher);
    const { id } = await queue.create(DEMO_CLINIC.id, { type: 'refill', callId: await closedCall(), patientId: null, idempotencyKey: 'refill-ready-1', details: { medication: 'lisinopril 10 mg', pharmacy: 'pick up at the clinic', callback_number: '+13035550163' } });
    // not yet approved: nothing goes out
    expect(await h.requestReady({ clinicId: DEMO_CLINIC.id, taskId: id })).toBe('skipped');
    await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.update(schema.tasks).set({ status: 'done', outcome: 'refill_ready' }).where(eq(schema.tasks.id, id)));
    expect(await h.requestReady({ clinicId: DEMO_CLINIC.id, taskId: id })).toBe('sent');
    expect(await h.requestReady({ clinicId: DEMO_CLINIC.id, taskId: id })).toBe('sent'); // a retry is not a second text
    expect(sent).toEqual([{ from: DEMO_CLINIC.phoneNumbers[0], to: '+13035550163', body: expect.stringContaining('your request is ready to pick up') }]);
    expect(sent[0]!.body).not.toMatch(/lisinopril/i);
    expect(await audits(DEMO_CLINIC.id, 'sms.sent.request_ready')).toHaveLength(1);
  });

  const approvedRefill = async (key: string, callId: string) => {
    const { id } = await new PostgresTaskQueue(t.db, cipher).create(DEMO_CLINIC.id, { type: 'refill', callId, patientId: null, idempotencyKey: key, details: { medication: 'x', pharmacy: 'y', callback_number: '+13035550177' } });
    await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.update(schema.tasks).set({ status: 'done', outcome: 'refill_ready' }).where(eq(schema.tasks.id, id)));
    return id;
  };
  const textFor = (taskId: string) => withClinic(t.db, DEMO_CLINIC.id, async (tx) => (await tx.select().from(schema.smsMessages).where(eq(schema.smsMessages.taskId, taskId)))[0]);

  it('texts "sent to your pharmacy" with the pharmacy and "please call us" for a refill not approved, never the medicine, and the clinic\'s own words', async () => {
    const sent: string[] = [];
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, texts: { send: async (m) => { sent.push(m.body); return { sid: `SM${'f'.repeat(31)}${sent.length}` }; } } });
    const decided = async (key: string, outcome: string, pharmacy: string) => {
      const { id } = await new PostgresTaskQueue(t.db, cipher).create(DEMO_CLINIC.id, { type: 'refill', callId: await closedCall(), patientId: null, idempotencyKey: key, details: { medication: 'carprofen 75 mg', pharmacy, callback_number: '+13035550177' } });
      await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.update(schema.tasks).set({ status: 'done', outcome: outcome as 'refill_sent' }).where(eq(schema.tasks.id, id)));
      return id;
    };
    const before = await clinicById(t.db, DEMO_CLINIC.id);
    const wording = JSON.stringify({ refill_sent: { en: { extra: 'Bring your ID when you collect it' } } });
    await t.db.execute(sql`update clinics set config = config || jsonb_build_object('texting', coalesce(config->'texting', '{}'::jsonb) || jsonb_build_object('wording', ${wording}::jsonb)) where id = ${DEMO_CLINIC.id}`);
    expect(await h.requestReady({ clinicId: DEMO_CLINIC.id, taskId: await decided('refill-sent-1', 'refill_sent', 'CVS on Main St') })).toBe('sent');
    expect(await h.requestReady({ clinicId: DEMO_CLINIC.id, taskId: await decided('refill-no-1', 'refill_declined', 'CVS on Main St') })).toBe('sent');
    // collected at the clinic: "sent to your pharmacy" would be wrong, so nothing goes out for it
    expect(await h.requestReady({ clinicId: DEMO_CLINIC.id, taskId: await decided('refill-sent-2', 'refill_sent', 'pick up at the clinic') })).toBe('skipped');
    expect(sent[0]).toContain('your request was sent to CVS on Main St.');
    expect(sent[0]).toContain('Bring your ID when you collect it. Reply STOP to opt out.');
    expect(sent[1]).toContain('about your recent request, please call us on');
    expect(sent.join(' ')).not.toMatch(/carprofen/i);
    await t.db.execute(sql`update clinics set config = ${JSON.stringify(before)}::jsonb where id = ${DEMO_CLINIC.id}`);
  });

  it('sends nothing when texts are off, and keeps why on the request', async () => {
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log });
    expect(await h.requestReady({ clinicId: DEMO_CLINIC.id, taskId: '00000000-0000-4000-8000-000000000000' })).toBe('skipped');
    const id = await approvedRefill('refill-ready-off', await closedCall());
    expect(await h.requestReady({ clinicId: DEMO_CLINIC.id, taskId: id })).toBe('off');
    expect(await textFor(id)).toMatchObject({ status: 'not_sent', failureReason: 'texting_off', template: 'request_ready' });
  });

  it('texts in the language the call was held in', async () => {
    const bodies: string[] = [];
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, texts: { send: async (m) => { bodies.push(m.body); return { sid: `SM${'e'.repeat(32)}` }; } } });
    const callId = await calls.open(DEMO_CLINIC.id, `live_worker_${++n}`, '+13035550147');
    await calls.close(DEMO_CLINIC.id, callId, { reason: 'caller_hangup', voiceSeconds: 30, outcome: 'task_created', emergency: false, language: 'es' });
    const id = await approvedRefill('refill-ready-es', callId);
    expect(await h.requestReady({ clinicId: DEMO_CLINIC.id, taskId: id })).toBe('sent');
    expect(bodies[0]).toContain('listo para recoger');
    expect(await textFor(id)).toMatchObject({ language: 'es', callId, status: 'sent' });
  });
});

describe('appointment reminders', () => {
  const REM = { ...DEMO_CLINIC, id: 'clinic_reminders', name: 'Reminder Vets', industry: 'vet' as const, phoneNumbers: ['+13035550300'],
    texting: Texting.parse({ reminders: { enabled: true, hoursBefore: 24 } }) };
  const tz = DEMO_CLINIC.timezone;
  let patientId: string;
  const visit = async (start: Date) => (await withClinic(t.db, REM.id, (tx) => tx.insert(schema.appointments).values({
    clinicId: REM.id, patientId, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: start, endsAt: new Date(start.getTime() + 20 * 60_000),
    idempotencyKey: `rem-${start.toISOString()}`, createdByUserId: 'u_ana',
  }).returning({ id: schema.appointments.id })))[0]!.id;
  beforeAll(async () => {
    await saveClinic(t.db, 'org_reminders', REM);
    patientId = await new PostgresPatientDirectory(t.db, cipher, 'seed').create(REM.id, { firstName: 'Biscuit', lastName: 'Okoye', dob: '2019-05-01', phone: '+13035550181' });
  });

  it('texts the visits coming up, once, only to people who said yes, and not in quiet hours', async () => {
    const bodies: string[] = [];
    const texts = { send: async (m: { body: string }) => { bodies.push(m.body); return { sid: `SM${'r'.repeat(31)}${bodies.length}` }; } };
    const at = (time: string) => () => zonedInstant('2026-10-06', time, tz);
    const soon = await visit(zonedInstant('2026-10-07', '10:00', tz));
    await visit(zonedInstant('2026-10-08', '15:00', tz)); // more than 24 hours away
    const h = (time: string) => handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, texts, now: at(time) });
    // no consent yet
    expect(await h('10:30').appointmentReminders()).toEqual({ sent: 0 });
    await withClinic(t.db, REM.id, (tx) => tx.update(schema.patients).set({ smsConsentAt: new Date(), smsConsentSource: 'staff' }).where(eq(schema.patients.id, patientId)));
    expect(await h('21:00').appointmentReminders()).toEqual({ sent: 0 }); // quiet hours
    expect(await h('10:30').appointmentReminders()).toEqual({ sent: 1 });
    expect(await h('10:40').appointmentReminders()).toEqual({ sent: 0 }); // claimed once
    expect(bodies).toEqual([expect.stringMatching(/^Reminder Vets: a reminder of Biscuit's visit on Wednesday, October 7 at 10:00 AM\. Reply C to confirm/)]);
    const [row] = await withClinic(t.db, REM.id, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.id, soon)));
    expect(row!.reminderSentAt).toBeInstanceOf(Date);
    expect(row!.reminderSmsId).toEqual(expect.any(String));
  });

  it('tries a reminder again when the carrier refused it for now, 3 times at most, and never shows it as sent', async () => {
    let fail = 2;
    const sent: string[] = [];
    const texts = { send: async (m: { body: string }) => { if (fail-- > 0) throw Object.assign(new Error('Service unavailable'), { code: 20503 }); sent.push(m.body); return { sid: `SM${'f'.repeat(32)}` }; } };
    let clock = zonedInstant('2026-10-11', '10:30', tz);
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, texts, now: () => clock });
    const id = await visit(zonedInstant('2026-10-12', '10:00', tz));
    const row = async () => (await withClinic(t.db, REM.id, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.id, id))))[0]!;
    expect(await h.appointmentReminders()).toEqual({ sent: 0 });
    expect((await row()).reminderSentAt).toBeNull(); // let go: the next run tries again
    clock = new Date(clock.getTime() + 10 * 60_000);
    expect(await h.appointmentReminders()).toEqual({ sent: 0 });
    clock = new Date(clock.getTime() + 10 * 60_000);
    expect(await h.appointmentReminders()).toEqual({ sent: 1 });
    expect(sent).toHaveLength(1);
    expect((await row()).reminderSentAt).toBeInstanceOf(Date);

    // a carrier that keeps refusing: 3 tries, then the visit is left alone
    fail = 99;
    const stuck = await visit(zonedInstant('2026-10-12', '09:00', tz));
    for (let i = 0; i < 5; i++) { clock = new Date(clock.getTime() + 10 * 60_000); await h.appointmentReminders(); }
    const [left] = await withClinic(t.db, REM.id, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.id, stuck)));
    expect(left!.reminderSentAt).toBeInstanceOf(Date);
  });

  it('knows quiet hours that run past midnight', () => {
    expect(quiet(21 * 60, '20:00', '08:00')).toBe(true);
    expect(quiet(7 * 60, '20:00', '08:00')).toBe(true);
    expect(quiet(8 * 60, '20:00', '08:00')).toBe(false);
    expect(quiet(13 * 60, '12:00', '14:00')).toBe(true);
    expect(quiet(13 * 60, '09:00', '09:00')).toBe(false);
  });
});

describe('the backup route', () => {
  it('keeps every active number of every open clinic in the map, with what to do for it, and nothing when it is off', async () => {
    let got: Map<string, { clinic: string; forwardTo: string | null }> | null = null;
    const fallback = { client: { ensure: async () => 'https://x.twil.io/fallback', sync: async (m: Map<string, never>) => { got = m; return { written: m.size, removed: 0 }; } }, trunkSid: 'TK1' };
    const at = zonedInstant('2026-09-29', '10:00', DEMO_CLINIC.timezone);
    const result = await handlers({ boss: { send: async () => null } as never, db: t.db, cipher, summariser: new LocalSummariser(), log, fallback, now: () => at }).fallbackSync();
    expect(result).toMatchObject({ removed: 0 });
    expect(got!.get('+13035550100')).toMatchObject({ clinic: DEMO_CLINIC.name, forwardTo: '+13035550101' });
    expect(await handlers({ boss: { send: async () => null } as never, db: t.db, cipher, summariser: new LocalSummariser(), log }).fallbackSync()).toBe('off');
  });
});
