import { DEMO_CLINIC } from '@attendra/core';
import { createPhiCipher, DEMO_PATIENTS, phiContext, purgeTextBodies, smsNumberHash } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

// Text history for the clinic (2026-11-16, demo findings 4, item 1): read-only. A pet's or patient's household's texts
// and the clinic's newest, with where each is, the words that went out (encrypted, kept for the clinic's call-records
// retention) and what each belongs to. Owners, managers and front desk; every read audited. Made-up data.
const C = `/api/v1/clinics/${DEMO_CLINIC.id}/texts`;
const cipher = createPhiCipher(TEST_DATA_KEY);
const maria = DEMO_PATIENTS[0];
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'staff' | 'viewer', string>;
let taskNumber: number;

const insert = async (clinicId: string, o: { template: string; status: string; to?: string; body?: string; reason?: string; code?: string; minutesAgo: number; taskId?: string | null; patientId?: string | null }) =>
  api.t.owner.execute(sql`insert into sms_messages (clinic_id, template, to_hash, status, idempotency_key, task_id, patient_id, failure_reason, error_code, body_enc, created_at, sent_at)
    values (${clinicId}, ${o.template}, ${smsNumberHash(cipher, clinicId, o.to ?? maria.phone)}, ${o.status}, ${`k-${Math.random()}`}, ${o.taskId ?? null}, ${o.patientId ?? null},
      ${o.reason ?? null}, ${o.code ?? null}, ${o.body ? cipher.encrypt(o.body, phiContext(clinicId, 'sms_messages.body')) : null},
      now() - make_interval(mins => ${o.minutesAgo}), ${o.status === 'not_sent' ? null : sql`now() - make_interval(mins => ${o.minutesAgo})`})`);
type Text = { template: string; status: string; body: string | null; taskNumber: number | null; patientName: string | null; toLast4: string | null; failureReason: string | null };
const read = async (q: string, cookie = as.staff) => (await api.request('GET', `${C}?${q}`, { cookie })).json().texts as Text[];

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  as = { owner: await api.signIn('omar@maple.example', true), staff: await api.signIn('ana@maple.example', true), viewer: await api.signIn('vic@maple.example', true) };
  const task = (await api.request('POST', `/api/v1/clinics/${DEMO_CLINIC.id}/tasks`, { cookie: as.staff, body: { type: 'refill', medication: 'Carprofen 75 mg', callbackNumber: maria.phone } })).json() as { id: string; number: number };
  taskNumber = task.number;
  await insert(DEMO_CLINIC.id, { template: 'booking_confirmed', status: 'delivered', body: 'Maple Street Family Medicine: Your visit is booked for Tue 9:00 AM.', minutesAgo: 30, patientId: api.patientIds.maria });
  await insert(DEMO_CLINIC.id, { template: 'request_ready', status: 'failed', code: '30006', minutesAgo: 20, taskId: task.id });
  await insert(DEMO_CLINIC.id, { template: 'directions', status: 'not_sent', reason: 'opted_out', minutesAgo: 10 });
  // someone else's number at this clinic, and the same number at another clinic: never in this household's texts
  await insert(DEMO_CLINIC.id, { template: 'hours', status: 'sent', to: '+13035550199', body: 'Our hours are 8 to 5.', minutesAgo: 5 });
  await insert(OTHER.id, { template: 'booking_confirmed', status: 'delivered', body: 'Other Clinic: booked.', minutesAgo: 1 });
});
afterAll(() => api.close());

describe('a household\'s texts', () => {
  it('every text to the number on the record, newest first, with where each is, its words and what it belongs to', async () => {
    const texts = await read(`patientId=${api.patientIds.maria}`);
    expect(texts.map((t) => [t.template, t.status])).toEqual([['directions', 'not_sent'], ['request_ready', 'failed'], ['booking_confirmed', 'delivered']]);
    expect(texts[2]!.body).toBe('Maple Street Family Medicine: Your visit is booked for Tue 9:00 AM.');
    expect(texts[1]).toMatchObject({ taskNumber, body: null });
    expect(texts[0]).toMatchObject({ failureReason: 'opted_out', body: null });
    expect(texts.every((t) => t.toLast4 === maria.phone.replace(/\D/g, '').slice(-4))).toBe(true);
  });
});

describe('the clinic\'s recent texts', () => {
  it('the newest, with the pet; only this clinic\'s; all or those not sent', async () => {
    const all = await read('recent=true&status=all');
    expect(all.map((t) => t.template)).toEqual(['hours', 'directions', 'request_ready', 'booking_confirmed']);
    expect(all.find((t) => t.template === 'booking_confirmed')!.patientName).toMatch(/Maria/);
    expect(JSON.stringify(all)).not.toContain('Other Clinic');
    expect((await read('recent=true&status=not_sent')).map((t) => t.template)).toEqual(['directions', 'request_ready']);
  });

  it('another clinic\'s staff never reach them, and a viewer reads no texts at all', async () => {
    expect((await api.request('GET', `/api/v1/clinics/${OTHER.id}/texts?recent=true`, { cookie: as.staff })).statusCode).toBe(404);
    for (const q of ['recent=true', `patientId=${api.patientIds.maria}`]) expect((await api.request('GET', `${C}?${q}`, { cookie: as.viewer })).statusCode, q).toBe(403);
  });

  it('every read is audited, by what was read, never with the words', async () => {
    await read('recent=true&status=all', as.owner);
    const rows = (await api.t.owner.execute(sql`select actor, action, entity, entity_id from audit_logs where action in ('texts.viewed', 'patient.texts.viewed') order by id`)).rows as { action: string; entity: string; entity_id: string }[];
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'patient.texts.viewed', entity: 'patient', entity_id: api.patientIds.maria }),
      expect.objectContaining({ action: 'texts.viewed', entity: 'clinic', entity_id: DEMO_CLINIC.id }),
    ]));
    expect(JSON.stringify(rows)).not.toMatch(/booked|hours are/i);
  });
});

describe('retention', () => {
  it('drops the words after the clinic\'s call-records period, and keeps the text\'s kind and status', async () => {
    const out = await purgeTextBodies(api.t.db, DEMO_CLINIC.id, new Date(Date.now() - 15 * 60_000));
    expect(out).toEqual({ textBodies: 1 });
    const texts = await read(`patientId=${api.patientIds.maria}`);
    expect(texts.find((t) => t.template === 'booking_confirmed')).toMatchObject({ status: 'delivered', body: null });
    // a newer one keeps its words; another clinic's are untouched
    expect((await read('recent=true')).find((t) => t.template === 'hours')!.body).toBe('Our hours are 8 to 5.');
    const other = (await api.t.owner.execute(sql`select count(*)::int n from sms_messages where clinic_id = ${OTHER.id} and body_enc is not null`)).rows[0] as { n: number };
    expect(other.n).toBe(1);
  });
});
