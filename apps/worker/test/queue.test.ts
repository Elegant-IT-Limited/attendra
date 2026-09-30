import { openTestDatabase } from '@attendra/db/testing';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, QUEUES, RETRY, WEBHOOK_RETRY } from '../src/queue';

let t: Awaited<ReturnType<typeof openTestDatabase>>;
let boss: PgBoss;
beforeAll(async () => { t = await openTestDatabase(); boss = createBoss({ pglite: t.client }); await boss.start(); }, 60_000);
afterAll(async () => { await boss.stop({ graceful: false }); await t.close(); });

describe('the queues', () => {
  it('ensureQueues(boss) with no arguments gives deliver-webhook its own 12 retries', async () => {
    await ensureQueues(boss);
    expect(await boss.getQueue(QUEUES.deliverWebhook)).toMatchObject({ retryLimit: WEBHOOK_RETRY.retryLimit, retryDelayMax: WEBHOOK_RETRY.retryDelayMax, expireInSeconds: WEBHOOK_RETRY.expireInSeconds });
    expect(WEBHOOK_RETRY.retryLimit).toBe(12);
    expect(await boss.getQueue(QUEUES.summariseCall)).toMatchObject({ retryLimit: RETRY.retryLimit });
  });

  it('brings a queue made with another policy back to its own on the next start', async () => {
    await ensureQueues(boss, { retryLimit: 1, retryDelay: 1, retryBackoff: false });
    expect(await boss.getQueue(QUEUES.deliverWebhook)).toMatchObject({ retryLimit: 1 });
    await ensureQueues(boss);
    expect(await boss.getQueue(QUEUES.deliverWebhook)).toMatchObject({ retryLimit: 12 });
  });
});
