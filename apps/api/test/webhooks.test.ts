import { DEMO_CLINIC } from '@attendra/core';
import { verify } from '@attendra/webhooks';
import type { WebhookEventJob } from '@attendra/worker/queue';
import { sql } from 'drizzle-orm';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'admin' | 'staff' | 'viewer' | 'outsider', string>;
let server: Server;
let base: string;
const received: { headers: IncomingMessage['headers']; body: string }[] = [];
const events: WebhookEventJob[] = [];

beforeAll(async () => {
  server = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.end(); }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api = await startApi({
    demoMode: false,
    jobs: { callCompleted: async () => {}, indexDocument: async () => {}, webhookEvent: async (e) => { events.push(e); } },
    // plain HTTP to this machine for the local receiver, and a resolver the tests control
    webhooks: { allowLoopback: true, resolve: async (host) => [{ address: host === 'internal.example.com' ? '10.1.2.3' : '93.184.216.34', family: 4 }] },
  });
  as = {
    owner: await api.signIn('omar@maple.example', true), admin: await api.signIn('olga@maple.example', true), staff: await api.signIn('ana@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true), outsider: await api.signIn('otto@other.example', true),
  };
});
afterAll(async () => { await api.close(); server.close(); });

const create = (cookie: string, body: unknown) => api.request('POST', `${C}/webhooks`, { cookie, body });

describe('webhook endpoints', () => {
  let endpointId: string;
  let secret: string;

  it('are for owners and managers only', async () => {
    for (const who of ['staff', 'viewer'] as const) {
      expect((await api.request('GET', `${C}/webhooks`, { cookie: as[who] })).statusCode).toBe(403);
      expect((await create(as[who], { url: 'https://hooks.example.com/x', events: ['request.done'] })).statusCode).toBe(403);
    }
    expect((await api.request('GET', `${C}/webhooks`, { cookie: as.outsider })).statusCode).toBe(404);
  });

  it('refuse a private, plain-HTTP or resolving-to-private address when saved', async () => {
    for (const [url, problem] of [
      ['http://hooks.example.com/x', 'https_only'], ['https://192.168.0.10/x', 'private_address'], ['https://169.254.169.254/latest', 'private_address'],
      ['https://internal.example.com/x', 'private_address'], ['https://printer.local/x', 'private_address'],
    ] as const) {
      const res = await create(as.admin, { url, events: ['request.done'] });
      expect(res.statusCode, url).toBe(422);
      expect(res.json().problem, url).toBe(problem);
    }
    expect((await create(as.admin, { url: 'https://hooks.example.com/x', events: [] })).statusCode).toBe(400);
  });

  it('show the secret once, when the endpoint is made, and never again', async () => {
    const res = await create(as.admin, { url: `${base}/n8n`, description: 'n8n', events: ['appointment.booked', 'request.done'] });
    expect(res.statusCode).toBe(201);
    ({ secret } = res.json());
    endpointId = res.json().endpoint.id;
    expect(secret).toMatch(/^whsec_/);
    const list = await api.request('GET', `${C}/webhooks`, { cookie: as.owner });
    expect(list.json().endpoints).toEqual([expect.objectContaining({ id: endpointId, url: `${base}/n8n`, enabled: true, events: ['appointment.booked', 'request.done'] })]);
    expect(list.body).not.toContain(secret);
    const stored = (await api.t.db.execute(sql`select secret_enc from webhook_endpoints where id = ${endpointId}`)).rows[0] as { secret_enc: string };
    expect(stored.secret_enc).not.toContain(secret.slice(6));
  });

  it('send a test event now, signed, and log it; a redelivery sends the same event again', async () => {
    const res = await api.request('POST', `${C}/webhooks/${endpointId}/test`, { cookie: as.admin });
    expect(res.json()).toMatchObject({ kind: 'test', statusCode: 200, error: null, eventType: 'webhook.test' });
    const got = received.at(-1)!;
    expect(verify(secret, got.headers as Record<string, string>, got.body)).toBe(true);
    expect(JSON.parse(got.body)).toMatchObject({ type: 'webhook.test', data: { clinicId: DEMO_CLINIC.id, endpointId, test: true } });
    const again = await api.request('POST', `${C}/webhooks/${endpointId}/attempts/${res.json().id}/redeliver`, { cookie: as.admin });
    expect(again.json()).toMatchObject({ kind: 'redelivery', statusCode: 200, eventId: res.json().eventId });
    expect(received.at(-1)!.headers['webhook-id']).toBe(got.headers['webhook-id']);
    const log = (await api.request('GET', `${C}/webhooks/${endpointId}/attempts`, { cookie: as.admin })).json().attempts;
    expect(log.map((a: { kind: string }) => a.kind)).toEqual(['redelivery', 'test']);
  });

  it('rotate the secret: shown once, and for a day deliveries verify with either', async () => {
    const res = await api.request('POST', `${C}/webhooks/${endpointId}/rotate-secret`, { cookie: as.admin });
    const fresh = res.json().secret as string;
    expect(fresh).not.toBe(secret);
    expect(res.json().endpoint.rotating).toBe(true);
    await api.request('POST', `${C}/webhooks/${endpointId}/test`, { cookie: as.admin });
    const got = received.at(-1)!;
    expect(verify(fresh, got.headers as Record<string, string>, got.body)).toBe(true);
    expect(verify(secret, got.headers as Record<string, string>, got.body)).toBe(true);
  });

  it('limits test events and redeliveries per clinic, so nobody can keep the sender busy', async () => {
    let limited = null as number | null;
    for (let i = 0; i < 12 && limited === null; i++) {
      const res = await api.request('POST', `${C}/webhooks/${endpointId}/test`, { cookie: as.admin });
      if (res.statusCode === 429) limited = i;
    }
    expect(limited).not.toBeNull();
    const last = (await api.request('GET', `${C}/webhooks/${endpointId}/attempts`, { cookie: as.admin })).json().attempts[0];
    expect((await api.request('POST', `${C}/webhooks/${endpointId}/attempts/${last.id}/redeliver`, { cookie: as.admin })).json()).toMatchObject({ error: 'rate_limited' });
  });

  it('records no test event for an endpoint that is not the clinic\'s own', async () => {
    const events = async () => Number(((await api.t.db.execute(sql`select count(*)::int as n from webhook_events where type = 'webhook.test'`)).rows[0] as { n: number }).n);
    const before = await events();
    expect((await api.request('POST', `/api/v1/clinics/${OTHER.id}/webhooks/${endpointId}/test`, { cookie: as.outsider })).statusCode).toBe(404);
    expect((await api.request('POST', `/api/v1/clinics/${OTHER.id}/webhooks/00000000-0000-4000-8000-000000000000/test`, { cookie: as.outsider })).statusCode).toBe(404);
    expect((await api.request('POST', `${C}/webhooks/not-a-uuid/test`, { cookie: as.admin })).statusCode).toBe(404);
    expect(await events()).toBe(before);
  });

  it('change, turn off and delete, all audited; another clinic cannot touch them', async () => {
    expect((await api.request('PUT', `/api/v1/clinics/${OTHER.id}/webhooks/${endpointId}`, { cookie: as.outsider, body: { enabled: false } })).statusCode).toBe(404);
    const off = await api.request('PUT', `${C}/webhooks/${endpointId}`, { cookie: as.admin, body: { enabled: false, events: ['request.done'] } });
    expect(off.json()).toMatchObject({ enabled: false, disabledReason: 'turned_off', events: ['request.done'] });
    expect((await api.request('PUT', `${C}/webhooks/${endpointId}`, { cookie: as.admin, body: { url: 'https://10.0.0.1/x' } })).statusCode).toBe(422);
    expect((await api.request('DELETE', `${C}/webhooks/${endpointId}`, { cookie: as.admin })).statusCode).toBe(204);
    const actions = (await api.t.db.execute(sql`select action from audit_logs where entity = 'webhook_endpoint' order by id`)).rows.map((r: unknown) => (r as { action: string }).action);
    expect(actions).toEqual(['webhook.endpoint.created', 'webhook.endpoint.secret_rotated', 'webhook.endpoint.updated', 'webhook.endpoint.deleted']);
  });
});

describe('events from the front desk', () => {
  it('a staff booking, a move and a cancellation become events with ids and times, and no names', async () => {
    const from = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10); // a week out, whatever today is
    const slots = (await api.request('GET', `${C}/appointments/slots?visitTypeId=vt_sick&providerId=prov_okafor&from=${from}&days=7`, { cookie: as.staff })).json();
    const [first, second] = slots.slots as { startsAt: string }[];
    const booked = await api.request('POST', `${C}/appointments`, { cookie: as.staff, body: { patientId: api.patientIds.james, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: first!.startsAt, idempotencyKey: 'hook-book-1' } });
    expect(booked.statusCode).toBe(200);
    const id = booked.json().appointmentId as string;
    await api.request('POST', `${C}/appointments/${id}/reschedule`, { cookie: as.staff, body: { startsAt: second!.startsAt } });
    await api.request('POST', `${C}/appointments/${id}/cancel`, { cookie: as.staff, body: { reason: 'patient_asked' } });
    await api.request('POST', `${C}/appointments/${id}/cancel`, { cookie: as.staff, body: { reason: 'patient_asked' } }); // twice changes nothing
    const mine = events.filter((e) => e.data.appointmentId === id);
    expect(mine.map((e) => e.type)).toEqual(['appointment.booked', 'appointment.rescheduled', 'appointment.cancelled']);
    expect(mine[0]!.data).toMatchObject({ patientId: api.patientIds.james, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: first!.startsAt, by: 'staff' });
    expect(mine[2]!.data).toMatchObject({ by: 'staff', reason: 'patient_asked' });
    expect(JSON.stringify(mine)).not.toMatch(/James|Whitaker|1962|5550163/);
  });

  it('closing a request is request.done, with its outcome', async () => {
    await api.request('POST', `${C}/tasks/${api.taskId}/claim`, { cookie: as.staff });
    await api.request('POST', `${C}/tasks/${api.taskId}/done`, { cookie: as.staff, body: { outcome: 'refill_sent' } });
    expect(events.at(-1)).toMatchObject({ type: 'request.done', data: { requestId: api.taskId, type: 'refill', outcome: 'refill_sent' } });
  });
});
