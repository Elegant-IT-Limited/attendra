import { DEMO_CLINIC } from '@attendra/core';
import { CallRepository, CallSummaryRepository, createPhiCipher, FrontDeskRepository, KnowledgeRepository, purgeCallRecords, saveClinic, schema, seedDemo, withClinic, workerJobs } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { and, eq, sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bossQueue, createBoss, jobId, QUEUES } from '../src/queue';
import { handlers, startWorker } from '../src/runtime';
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
  await calls.recordAction(clinicId, callId, { tool: 'verify_caller', argsRedacted: ['full_name', 'date_of_birth'], result: { ok: true, verified: true }, idempotencyKey: null, taskRevision: 1 });
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
    const actions = (await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.callId, callId)))).map((a) => `${a.actor} ${a.action}`);
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

describe('the retention purge', () => {
  it('deletes transcripts and summaries past each clinic\'s retention, and audits how many, never what', async () => {
    await saveClinic(t.db, 'org_other', { ...OTHER, retentionDays: 30 } as typeof OTHER);
    const old = await closedCall(OTHER.id);
    const recent = await closedCall(OTHER.id);
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, now: () => new Date() });
    await h.summariseCall({ clinicId: OTHER.id, callId: old });
    await t.db.execute(sql`update calls set started_at = now() - interval '40 days' where id = ${old}`);

    await calls.recordAction(OTHER.id, old, { tool: 'get_clinic_info', argsRedacted: ['question'], result: { ok: true }, idempotencyKey: null, taskRevision: 1 });
    await calls.recordAction(OTHER.id, recent, { tool: 'get_clinic_info', argsRedacted: ['question'], result: { ok: true }, idempotencyKey: null, taskRevision: 1 });

    const actionsOf = async (id: string) => ((await t.db.execute(sql`select count(*)::int as n from call_actions where call_id = ${id}`)).rows[0] as { n: number }).n;
    const oldActions = await actionsOf(old);
    const recentActions = await actionsOf(recent);

    const results = await h.purgeRetention();
    expect(results.find((r) => r.clinicId === OTHER.id)).toEqual({ clinicId: OTHER.id, transcriptLines: 1, summaries: 1, callActions: oldActions });
    expect(results.find((r) => r.clinicId === DEMO_CLINIC.id)).toMatchObject({ transcriptLines: 0, summaries: 0, callActions: 0 }); // 2555 days by default
    expect(await actionsOf(old)).toBe(0);
    expect(await actionsOf(recent)).toBe(recentActions);
    expect(await calls.transcript(OTHER.id, old)).toEqual([]);
    expect(await calls.transcript(OTHER.id, recent)).toHaveLength(1);
    const [audit] = await audits(OTHER.id, 'retention.purged');
    expect(audit).toMatchObject({ actor: 'worker', entity: 'clinic', counts: { transcriptLines: 1, summaries: 1, callActions: oldActions } });
  });

  it('works through old calls in batches, each its own transaction', async () => {
    const ids = [await closedCall(OTHER.id), await closedCall(OTHER.id), await closedCall(OTHER.id)];
    await t.db.execute(sql`update calls set started_at = now() - interval '50 days' where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    const counts = await purgeCallRecords(t.db, OTHER.id, new Date(Date.now() - 30 * 86_400_000), 2);
    expect(counts.transcriptLines).toBe(3);
    for (const id of ids) expect(await calls.transcript(OTHER.id, id)).toEqual([]);
  });
});

describe('text delivery status', () => {
  it('records a status for a text it sent, by Twilio\'s id, and nothing for one it did not', async () => {
    const sid = `SM${'a'.repeat(32)}`;
    await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.insert(schema.smsMessages).values({ clinicId: DEMO_CLINIC.id, template: 'booking_confirmed', toHash: 'h', idempotencyKey: 'k-sms', status: 'sent', providerSid: sid }));
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log });
    expect(await h.smsStatus({ clinicId: DEMO_CLINIC.id, messageSid: sid, status: 'delivered' })).toBe('updated');
    expect(await h.smsStatus({ clinicId: DEMO_CLINIC.id, messageSid: `SM${'b'.repeat(32)}`, status: 'delivered' })).toBe('unknown');
    await expect(h.smsStatus({ clinicId: DEMO_CLINIC.id, messageSid: 'not-a-sid', status: 'delivered' })).rejects.toThrow();
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
