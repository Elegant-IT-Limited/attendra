import { DEMO_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/runtime';
import { ModelSummariser } from '../src/summarise';

// RPT-slack-alerts-2: a call summary that failed because the OpenAI credit or quota was used up reached Slack as
// job_failed (the dead letter after its retries), not as openai_quota, which pages: only the voice service raised that.
// The summary job now says openai_quota itself, and its dead letter says the same. Made-up call; no OpenAI is called.
const cipher = createPhiCipher(TEST_DATA_KEY);
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let calls: CallRepository;
let n = 0;

async function closedCall() {
  const callId = await calls.open(DEMO_CLINIC.id, `live_quota_${++n}`, '+13035550147');
  await calls.appendSegment(DEMO_CLINIC.id, callId, { speaker: 'caller', text: 'Hi, can I book a check-up for my dog?', startMs: 0, endMs: 900 });
  await calls.close(DEMO_CLINIC.id, callId, { reason: 'caller_hangup', voiceSeconds: 30, outcome: 'info', emergency: false });
  return callId;
}

/** What the OpenAI SDK throws when the project has no credit left: a 429 with code insufficient_quota. */
const quotaError = () => Object.assign(new Error('429 You exceeded your current quota, please check your plan and billing details.'), {
  status: 429, code: 'insufficient_quota', type: 'insufficient_quota', error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' },
});
/** And a plain rate limit: a 429 that is not money. */
const rateLimit = () => Object.assign(new Error('429 Rate limit reached for requests'), { status: 429, code: 'rate_limit_exceeded', type: 'requests' });
const openai = (err: () => Error) => ({ responses: { create: async () => { throw err(); } } }) as never;

function alertsSpy() {
  const sent: { kind: string; text: string; where?: { clinicId?: string; callId?: string } }[] = [];
  return { sent, alerts: { alert: (kind: string, text: string, where?: { clinicId?: string; callId?: string }) => { sent.push({ kind, text, where }); }, resolved: () => {}, note: () => {}, flush: async () => {} } };
}

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  calls = new CallRepository(t.db, cipher);
});
afterAll(() => t.close());

describe('RPT-slack-alerts-2: a summary that fails on the OpenAI quota says openai_quota', () => {
  it('RPT-slack-alerts-2: the summary job alerts openai_quota, and its dead letter says openai_quota, never job_failed', async () => {
    const { sent, alerts } = alertsSpy();
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new ModelSummariser(openai(quotaError), 'gpt-test'), log, alerts });
    const callId = await closedCall();
    // still a failure, so the queue tries again once there is credit
    await expect(h.summariseCall({ clinicId: DEMO_CLINIC.id, callId })).rejects.toThrow('openai_quota');
    expect(sent.map((a) => a.kind)).toEqual(['openai_quota']);
    expect(sent[0]!.text).toMatch(/OpenAI/);
    expect(sent[0]!.where).toEqual({ clinicId: DEMO_CLINIC.id, callId });
    // after its retries the job is dead-lettered: the same kind, not "a background job gave up"
    await h.deadLetter({ clinicId: DEMO_CLINIC.id, callId });
    expect(sent.map((a) => a.kind)).toEqual(['openai_quota', 'openai_quota']);
    expect(sent.some((a) => a.kind === 'job_failed')).toBe(false);
  });

  it('RPT-slack-alerts-2: a rate limit or any other failure is not a quota alert, and its dead letter is still job_failed', async () => {
    const { sent, alerts } = alertsSpy();
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new ModelSummariser(openai(rateLimit), 'gpt-test'), log, alerts });
    const callId = await closedCall();
    await expect(h.summariseCall({ clinicId: DEMO_CLINIC.id, callId })).rejects.toThrow('summary_model_http_429');
    expect(sent).toEqual([]);
    await h.deadLetter({ clinicId: DEMO_CLINIC.id, callId });
    expect(sent.map((a) => a.kind)).toEqual(['job_failed']);
  });
});
