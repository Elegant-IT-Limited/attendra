import { DEMO_CLINIC } from '@attendra/core';
import { schema, withClinic } from '@attendra/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}/texts`;
let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
let viewer: string;

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  staff = await api.signIn('ana@maple.example', true);
  viewer = await api.signIn('vic@maple.example', true);
  await withClinic(api.t.db, DEMO_CLINIC.id, (tx) => tx.insert(schema.smsMessages).values([
    { clinicId: DEMO_CLINIC.id, template: 'booking_confirmed', toHash: 'h1', idempotencyKey: 'texts-1', status: 'delivered', callId: api.callId, patientId: api.patientIds.maria!, sentAt: new Date(), deliveredAt: new Date() },
    { clinicId: DEMO_CLINIC.id, template: 'request_ready', toHash: 'h2', idempotencyKey: 'texts-2', status: 'not_sent', failureReason: 'opted_out', taskId: api.taskId },
  ]));
});
afterAll(() => api.close());

describe('whether a text went', () => {
  it('lists the texts about a call, a request or a patient, with the reason one was not sent', async () => {
    const byCall = await api.request('GET', `${C}?callId=${api.callId}`, { cookie: staff });
    expect(byCall.statusCode).toBe(200);
    expect(byCall.json().texts).toEqual([expect.objectContaining({ template: 'booking_confirmed', status: 'delivered', toLast4: null, deliveredAt: expect.any(String) })]);
    const byTask = (await api.request('GET', `${C}?taskId=${api.taskId}`, { cookie: staff })).json();
    expect(byTask.texts).toEqual([expect.objectContaining({ template: 'request_ready', status: 'not_sent', failureReason: 'opted_out' })]);
    const byPatient = (await api.request('GET', `${C}?patientId=${api.patientIds.maria}`, { cookie: staff })).json();
    expect(byPatient.texts[0].toLast4).toMatch(/^\d{4}$/);
  });

  it('audits a patient\'s texts as a view, and nothing else', async () => {
    const views = () => withClinic(api.t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.clinicId, DEMO_CLINIC.id), eq(schema.auditLogs.action, 'patient.texts.viewed'))));
    expect(await views()).toHaveLength(1);
    await api.request('GET', `${C}?callId=${api.callId}`, { cookie: staff });
    expect(await views()).toHaveLength(1);
  });

  it('needs exactly one filter, and is not for viewers', async () => {
    expect((await api.request('GET', C, { cookie: staff })).statusCode).toBe(422);
    expect((await api.request('GET', `${C}?callId=${api.callId}&taskId=${api.taskId}`, { cookie: staff })).statusCode).toBe(422);
    expect((await api.request('GET', `${C}?callId=${api.callId}`, { cookie: viewer })).statusCode).toBe(403);
  });
});
