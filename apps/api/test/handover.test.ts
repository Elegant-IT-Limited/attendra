import { ClinicConfig, DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { saveClinic } from '@attendra/db';
import type { HandoverJob, WebhookEventJob } from '@attendra/worker/queue';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

// Monday 28 September 2026, 8 pm in Denver
const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);
const at = (date: string, time: string) => zonedInstant(date, time, DEMO_CLINIC.timezone).toISOString();
const S = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const D = `${S}/doctors`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'admin' | 'staff' | 'viewer', string>;
let kim: string;
const visits: Record<'a' | 'b' | 'c' | 'd', string> = { a: '', b: '', c: '', d: '' };
const events: WebhookEventJob[] = [];
const texts: HandoverJob[] = [];

const book = async (providerId: string, visitTypeId: string, startsAt: string, patient: 'maria' | 'james', key: string, override = false) => {
  const res = await api.request('POST', `${S}/appointments`, { cookie: as.owner, body: {
    patientId: api.patientIds[patient], providerId, visitTypeId, startsAt, idempotencyKey: `handover-${key}`, ...(override ? { override: true, overrideReason: 'own hours' } : {}),
  } });
  if (res.statusCode !== 201) throw new Error(`${key}: ${res.body}`);
  return res.json().appointmentId as string;
};

beforeAll(async () => {
  api = await startApi({
    demoMode: false, now: () => NOW,
    jobs: { callCompleted: async () => {}, indexDocument: async () => {}, webhookEvent: async (e) => { events.push(e); }, requestReady: async () => {}, smsStatus: async () => {}, visitHandedOver: async (j) => { texts.push(j); } },
  });
  // texting on, the demo's holidays out of the way
  await saveClinic(api.t.db, 'org_demo', ClinicConfig.parse({ ...DEMO_CLINIC, holidays: [], texting: { enabled: true } }));
  as = {
    owner: await api.signIn('omar@maple.example', true), admin: await api.signIn('olga@maple.example', true),
    staff: await api.signIn('ana@maple.example', true), viewer: await api.signIn('vic@maple.example', true),
  };
  // a doctor who also works Friday afternoons, when nobody else does
  const day = [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }];
  const added = await api.request('POST', D, { cookie: as.owner, body: {
    name: 'Dr. Jae Kim', gender: 'male', acceptingNewPatients: true, categories: [], timeOff: [], visitTypeIds: ['vt_sick', 'vt_annual', 'vt_new'],
    hours: { '1': day, '2': day, '3': day, '4': day, '5': [{ open: '08:00', close: '17:00' }] },
  } });
  kim = added.json().providers.find((p: { name: string }) => p.name === 'Jae Kim').id;
  await api.t.owner.execute(sql`update patients set sms_consent_at = now(), sms_consent_source = 'staff' where id = ${api.patientIds.maria!}`);
  // Wednesday: Dr. Okafor already has 9:00, so Dr. Raman takes Kim's 9:00; 10:00 goes to whoever can take the most
  await book('prov_okafor', 'vt_sick', at('2026-09-30', '09:00'), 'james', 'okafor-busy');
  visits.a = await book(kim, 'vt_sick', at('2026-09-30', '09:00'), 'maria', 'a');
  visits.b = await book(kim, 'vt_annual', at('2026-09-30', '10:00'), 'maria', 'b');
  // Friday 2 pm: the clinic is closed, only Kim works: nobody can take it
  visits.c = await book(kim, 'vt_sick', at('2026-10-02', '14:00'), 'maria', 'c');
  // Thursday: a new patient visit, which Dr. Lindqvist does not do and Dr. Raman is not in for
  visits.d = await book(kim, 'vt_new', at('2026-10-01', '09:00'), 'james', 'd');
  await api.t.owner.execute(sql`update appointments set confirmed_at = now(), confirmed_via = 'text', reminder_sent_at = now() where id = ${visits.a}`);
});
afterAll(() => api.close());

describe('handing a doctor\'s visits to others before removing them (note 32)', () => {
  it('is for owners and managers, and another clinic\'s doctor is not found', async () => {
    for (const who of ['staff', 'viewer'] as const) expect((await api.request('POST', `${D}/${kim}/handover/preview`, { cookie: as[who], body: {} })).statusCode).toBe(403);
    expect((await api.request('POST', `/api/v1/clinics/${OTHER.id}/doctors/${kim}/handover/preview`, { cookie: as.owner, body: {} })).statusCode).toBe(404);
    expect((await api.request('POST', `${D}/prov_nobody/handover/preview`, { cookie: as.owner, body: {} })).statusCode).toBe(404);
    expect((await api.request('POST', `${D}/${kim}/handover/preview`, { cookie: as.owner, body: { toProviderId: kim } })).statusCode).toBe(422);
  });

  it('previews who takes each visit at the same time, and lists what nobody can take with why; nothing changes', async () => {
    const res = await api.request('POST', `${D}/${kim}/handover/preview`, { cookie: as.admin, body: {} });
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json();
    const by = (id: string) => p.visits.find((v: { appointmentId: string }) => v.appointmentId === id);
    expect(p.visits.map((v: { appointmentId: string }) => v.appointmentId)).toEqual([visits.a, visits.b, visits.d, visits.c]);
    expect(by(visits.a)).toMatchObject({ toProviderId: 'prov_raman', reason: null, textable: true });
    expect(by(visits.b).toProviderId).not.toBeNull();
    expect(by(visits.d)).toMatchObject({ toProviderId: 'prov_okafor', textable: false });
    expect(by(visits.c)).toMatchObject({ toProviderId: null, reason: 'closed', message: 'No doctor who does it works then.' });
    expect(p.textingOn).toBe(true);
    expect(res.body).not.toMatch(/Maria|Delgado|James|Whitaker/);
    // one doctor for all of them: Dr. Lindqvist works neither Wednesday nor Friday, and does no new patient visits
    const one = (await api.request('POST', `${D}/${kim}/handover/preview`, { cookie: as.admin, body: { toProviderId: 'prov_lindqvist' } })).json();
    expect(one.visits.map((v: { reason: string | null }) => v.reason)).toEqual(['closed', 'closed', 'not_offered', 'closed']);
    expect(one.visits.find((v: { appointmentId: string }) => v.appointmentId === visits.d).message).toBe('This doctor does not do this visit type.');
    expect(((await api.t.owner.execute(sql`select count(*)::int as n from appointments where provider_id = ${kim} and status = 'booked'`)).rows[0] as { n: number }).n).toBe(4);
  });

  it('moves what was confirmed, texts only the owners who agreed, keeps the reminder and the confirmation, and lists what stays', async () => {
    const plan = (await api.request('POST', `${D}/${kim}/handover/preview`, { cookie: as.admin, body: {} })).json();
    const moves = plan.visits.filter((v: { toProviderId: string | null }) => v.toProviderId).map((v: { appointmentId: string; toProviderId: string }) => ({ appointmentId: v.appointmentId, toProviderId: v.toProviderId }));
    const res = await api.request('POST', `${D}/${kim}/handover`, { cookie: as.admin, body: { moves, textOwners: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ moved: 3, notMoved: [], texts: { queued: 2, notTexted: 1 }, remaining: 1 });
    expect(texts.map((t) => t.appointmentId).sort()).toEqual([visits.a, visits.b].sort());
    const a = (await api.t.owner.execute(sql`select provider_id, starts_at, confirmed_at, reminder_sent_at from appointments where id = ${visits.a}`)).rows[0] as Record<string, unknown>;
    expect(a.provider_id).toBe('prov_raman');
    expect(new Date(a.starts_at as string).toISOString()).toBe(at('2026-09-30', '09:00'));
    expect(a.confirmed_at).not.toBeNull();
    expect(a.reminder_sent_at).not.toBeNull();
    expect(events.filter((e) => e.type === 'appointment.rescheduled').map((e) => e.data.appointmentId).sort()).toEqual([visits.a, visits.b, visits.d].sort());
    const [audit] = (await api.t.owner.execute(sql`select actor, entity_id, counts from audit_logs where action = 'clinic.doctor.handover'`)).rows as { actor: string; entity_id: string; counts: Record<string, number> }[];
    expect(audit).toMatchObject({ entity_id: kim, counts: { moved: 3, notMoved: 0, textsQueued: 2, remaining: 1 } });
    // the one left still blocks the removal; once it is cancelled, the doctor goes
    expect((await api.request('DELETE', `${D}/${kim}`, { cookie: as.owner })).statusCode).toBe(409);
    expect((await api.request('POST', `${S}/appointments/${visits.c}/cancel`, { cookie: as.owner, body: { reason: 'clinic_asked' } })).statusCode).toBe(200);
    expect((await api.request('DELETE', `${D}/${kim}`, { cookie: as.owner })).statusCode).toBe(200);
  });

  it('a move that is no longer the doctor\'s, or would clash, is listed and not made; no text without a yes', async () => {
    texts.length = 0;
    const add = await api.request('POST', D, { cookie: as.owner, body: { name: 'Dr. Lee Park', gender: 'female', acceptingNewPatients: true, categories: [], timeOff: [], visitTypeIds: ['vt_sick'] } });
    const park = add.json().providers.find((p: { name: string }) => p.name === 'Lee Park').id as string;
    const mine = await book(park, 'vt_sick', at('2026-09-30', '11:00'), 'maria', 'park-1');
    // Dr. Okafor is taken at 11:00 meanwhile
    await book('prov_okafor', 'vt_sick', at('2026-09-30', '11:00'), 'james', 'okafor-11');
    const res = (await api.request('POST', `${D}/${park}/handover`, { cookie: as.admin, body: { moves: [{ appointmentId: mine, toProviderId: 'prov_okafor' }, { appointmentId: visits.a, toProviderId: 'prov_okafor' }], textOwners: false } })).json();
    expect(res.moved).toBe(0);
    expect(res.notMoved.map((n: { reason: string }) => n.reason)).toEqual(['taken', 'not_theirs']);
    expect(res.notMoved[0].message).toBe('This doctor has another visit then.');
    expect(res.texts).toEqual({ queued: 0, notTexted: 0 });
    expect(texts).toHaveLength(0);
    expect(res.remaining).toBe(1);
  });
});
