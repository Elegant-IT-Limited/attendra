import { DEMO_CLINIC } from '@attendra/core';
import { createPhiCipher, saveClinic, seedDemo, WebhookRepository } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { newSecret, verify } from '@attendra/webhooks';
import { sql } from 'drizzle-orm';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bossQueue, createBoss, eventSink } from '../src/queue';
import { startWorker } from '../src/runtime';
import { LocalSummariser } from '../src/summarise';

const cipher = createPhiCipher(TEST_DATA_KEY);
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };

let t: Awaited<ReturnType<typeof openTestDatabase>>;
let boss: PgBoss;
let server: Server;
let base: string;
const received: { path: string; headers: IncomingMessage['headers']; body: string }[] = [];
const hooks = () => new WebhookRepository(t.db, cipher);

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 200));
  }
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ path: req.url ?? '', headers: req.headers, body }); res.statusCode = req.url === '/broken' ? 500 : 200; res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  await saveClinic(t.db, 'org_other', OTHER);
  boss = createBoss({ pglite: t.client });
  await boss.start();
  await startWorker({
    boss, db: t.db, cipher, summariser: new LocalSummariser(), log, schedulePurge: false,
    retry: { retryLimit: 1, retryDelay: 1, retryBackoff: false }, events: eventSink(bossQueue(boss)), webhooks: { allowLoopback: true },
  });
}, 60_000);
afterAll(async () => { await boss.stop({ graceful: false }); await t.close(); server.close(); });

describe('webhook deliveries', () => {
  it('sends an event to each endpoint that wants it, signed, once, and logs the attempt', async () => {
    const secret = newSecret();
    const wants = await hooks().create(DEMO_CLINIC.id, { url: `${base}/hook`, description: 'n8n', events: ['request.done'], secret, userId: 'u_olga' });
    await hooks().create(DEMO_CLINIC.id, { url: `${base}/other`, description: 'not this one', events: ['appointment.booked'], secret: newSecret(), userId: 'u_olga' });
    await hooks().create(OTHER.id, { url: `${base}/theirs`, description: 'another clinic', events: ['request.done'], secret: newSecret(), userId: 'u_otto' });
    const sink = eventSink(bossQueue(boss));
    const event = { type: 'request.done' as const, key: 'task_1', data: { requestId: 'task_1', type: 'refill', outcome: 'refill_sent', callId: null } };
    await sink.emit(DEMO_CLINIC.id, event);
    await sink.emit(DEMO_CLINIC.id, event); // the same event again
    await until(async () => received.some((r) => r.path === '/hook'));
    await new Promise((r) => setTimeout(r, 1500));
    const got = received.filter((r) => r.path === '/hook');
    expect(got).toHaveLength(1);
    expect(received.some((r) => r.path === '/other' || r.path === '/theirs')).toBe(false);
    expect(verify(secret, got[0]!.headers as Record<string, string>, got[0]!.body)).toBe(true);
    expect(JSON.parse(got[0]!.body)).toMatchObject({ type: 'request.done', data: { clinicId: DEMO_CLINIC.id, requestId: 'task_1', outcome: 'refill_sent' } });
    const attempts = await hooks().attempts(DEMO_CLINIC.id, wants);
    expect(attempts).toEqual([expect.objectContaining({ kind: 'automatic', attempt: 1, statusCode: 200, error: null, eventType: 'request.done' })]);
  });

  it('leaves out patient ids unless the endpoint was set to send them', async () => {
    const plain = await hooks().create(DEMO_CLINIC.id, { url: `${base}/no-ids`, description: 'default', events: ['appointment.booked'], secret: newSecret(), userId: 'u_olga' });
    await hooks().create(DEMO_CLINIC.id, { url: `${base}/with-ids`, description: 'under a BAA', events: ['appointment.booked'], secret: newSecret(), userId: 'u_olga', omitPatientIds: false });
    expect((await hooks().get(DEMO_CLINIC.id, plain))!.omitPatientIds).toBe(true);
    await eventSink(bossQueue(boss)).emit(DEMO_CLINIC.id, { type: 'appointment.booked', key: 'appt_ids', data: { appointmentId: 'appt_ids', patientId: 'patient_1', startsAt: '2026-10-06T15:00:00.000Z', by: 'staff' } });
    const got = await until(async () => { const a = received.find((r) => r.path === '/no-ids'); const b = received.find((r) => r.path === '/with-ids'); return a && b ? [a, b] : null; });
    expect(JSON.parse(got[0].body).data).not.toHaveProperty('patientId');
    expect(JSON.parse(got[0].body).data).toMatchObject({ appointmentId: 'appt_ids', startsAt: '2026-10-06T15:00:00.000Z' });
    expect(JSON.parse(got[1].body).data).toMatchObject({ patientId: 'patient_1' });
  }, 30_000);

  it('retries a failing endpoint, and turns it off after it has failed three events in a row, audited', async () => {
    const id = await hooks().create(DEMO_CLINIC.id, { url: `${base}/broken`, description: 'down', events: ['appointment.cancelled'], secret: newSecret(), userId: 'u_olga' });
    const sink = eventSink(bossQueue(boss));
    for (const n of [1, 2, 3]) {
      await sink.emit(DEMO_CLINIC.id, { type: 'appointment.cancelled', key: `appt_${n}`, data: { appointmentId: `appt_${n}`, by: 'staff' } });
      // each event: the first try and one retry (the test's retry limit), then it counts against the endpoint
      await until(async () => (await hooks().attempts(DEMO_CLINIC.id, id)).filter((a) => a.eventId.length && a.attempt === 2).length >= n, 30_000);
    }
    const endpoint = await until(async () => { const e = await hooks().get(DEMO_CLINIC.id, id); return e && !e.enabled ? e : null; });
    expect(endpoint).toMatchObject({ enabled: false, disabledReason: 'repeated_failures', consecutiveFailures: 3 });
    const attempts = await hooks().attempts(DEMO_CLINIC.id, id);
    expect(attempts.every((a) => a.statusCode === 500 && a.error === 'http_500')).toBe(true);
    expect((await t.db.execute(sql`select actor from audit_logs where action = 'webhook.endpoint.disabled' and entity_id = ${id}`)).rows).toEqual([{ actor: 'worker' }]);
    // turned off, it gets nothing more
    const before = received.filter((r) => r.path === '/broken').length;
    await sink.emit(DEMO_CLINIC.id, { type: 'appointment.cancelled', key: 'appt_4', data: { appointmentId: 'appt_4', by: 'staff' } });
    await new Promise((r) => setTimeout(r, 2500));
    expect(received.filter((r) => r.path === '/broken').length).toBe(before);
  }, 90_000);

  it('refuses to deliver to a private address, even when the endpoint was saved before the rule', async () => {
    const id = await hooks().create(DEMO_CLINIC.id, { url: 'https://10.0.0.8/hook', description: 'internal', events: ['request.created'], secret: newSecret(), userId: 'u_olga' });
    await eventSink(bossQueue(boss)).emit(DEMO_CLINIC.id, { type: 'request.created', key: 'task_9', data: { requestId: 'task_9', type: 'callback' } });
    const attempts = await until(async () => { const a = await hooks().attempts(DEMO_CLINIC.id, id); return a.length ? a : null; });
    expect(attempts[0]).toMatchObject({ statusCode: null, error: 'private_address' });
  }, 30_000);
});
