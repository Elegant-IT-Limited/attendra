import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { createPhiCipher, PostgresPatientDirectory } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import type { WebhookEventJob } from '@attendra/worker/queue';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);
const P = `/api/v1/clinics/${DEMO_CLINIC.id}/patients`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'admin' | 'staff' | 'viewer' | 'outsider', string>;
const events: WebhookEventJob[] = [];

const add = async (firstName: string, lastName: string, phone: string, dob = '1980-01-01') => {
  const res = await api.request('POST', P, { cookie: as.staff, body: { firstName, lastName, dob, phone, gender: 'female' } });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id as string;
};

beforeAll(async () => {
  api = await startApi({
    demoMode: false, now: () => NOW,
    jobs: { callCompleted: async () => {}, indexDocument: async () => {}, webhookEvent: async (e) => { events.push(e); }, requestReady: async () => {}, smsStatus: async () => {} },
  });
  as = {
    owner: await api.signIn('omar@maple.example', true), admin: await api.signIn('olga@maple.example', true), staff: await api.signIn('ana@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true), outsider: await api.signIn('otto@other.example', true),
  };
});
afterAll(() => api.close());

describe('deleting and merging patient records', () => {
  it('is for owners and practice managers: the front desk and a viewer are refused, another clinic answers 404', async () => {
    const id = await add('Tess', 'Arden', '+13035550151');
    for (const who of ['staff', 'viewer'] as const) {
      expect((await api.request('POST', `${P}/${id}/delete/preview`, { cookie: as[who], body: {} })).statusCode, who).toBe(403);
      expect((await api.request('POST', `${P}/${id}/delete`, { cookie: as[who], body: {} })).statusCode, who).toBe(403);
      expect((await api.request('POST', `${P}/merge`, { cookie: as[who], body: { kind: 'pet', keepId: id, mergeId: id } })).statusCode, who).toBe(403);
    }
    // someone of another clinic, on their own clinic's path with this clinic's record: not found, and nothing changed
    expect((await api.request('POST', `/api/v1/clinics/${OTHER.id}/patients/${id}/delete`, { cookie: as.outsider, body: {} })).statusCode).toBe(404);
    expect((await api.request('POST', `${P}/${id}/delete`, { cookie: as.outsider, body: {} })).statusCode).toBe(404);
    expect((await api.request('GET', `${P}/${id}`, { cookie: as.staff })).statusCode).toBe(200);
  });

  it('a delete shows what goes first, then removes the record: gone from search and its profile, the visit to come cancelled and announced', async () => {
    const id = await add('Wren', 'Calder', '+13035550152');
    const booked = await api.request('POST', `/api/v1/clinics/${DEMO_CLINIC.id}/appointments`, { cookie: as.staff, body: {
      patientId: id, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: zonedInstant('2026-09-30', '09:00', DEMO_CLINIC.timezone).toISOString(), idempotencyKey: 'removal-api-1',
    } });
    const appointmentId = booked.json().appointmentId as string;
    const preview = await api.request('POST', `${P}/${id}/delete/preview`, { cookie: as.admin, body: { scope: 'pet' } });
    expect(preview.json()).toEqual({ records: 1, upcomingCancelled: 1, visitsKept: 0, requests: 0, callsUnlinked: 0 });
    const done = await api.request('POST', `${P}/${id}/delete`, { cookie: as.admin, body: { scope: 'pet' } });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toEqual({ records: 1, upcomingCancelled: 1, visitsKept: 0, requests: 0, callsUnlinked: 0 });
    expect((await api.request('GET', `${P}/${id}`, { cookie: as.staff })).statusCode).toBe(404);
    expect((await api.request('POST', `${P}/search`, { cookie: as.staff, body: { query: 'Calder' } })).json().patients).toEqual([]);
    expect((await api.request('PATCH', `${P}/${id}`, { cookie: as.staff, body: { firstName: 'Wren', lastName: 'Calder', dob: '1980-01-01', phone: '+13035550152', gender: 'female' } })).statusCode).toBe(404);
    expect(events.filter((e) => e.type === 'appointment.cancelled').map((e) => e.data.appointmentId)).toContain(appointmentId);
    // nothing can be booked for it now
    const again = await api.request('POST', `/api/v1/clinics/${DEMO_CLINIC.id}/appointments`, { cookie: as.staff, body: {
      patientId: id, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: zonedInstant('2026-10-01', '09:00', DEMO_CLINIC.timezone).toISOString(), idempotencyKey: 'removal-api-2',
    } });
    expect(again.statusCode).toBe(404);
    // the audit row names who and which record, never what
    const [row] = (await api.t.owner.execute(sql`select actor from audit_logs where action = 'patient.deleted' and entity_id = ${id}`)).rows as { actor: string }[];
    expect(row!.actor).toBe(`user:${api.users.admin}`);
    expect(done.body).not.toMatch(/Wren|Calder|5550152/);
  });

  it('a merge shows what moves first, then moves it; two records of one household refuse a household merge', async () => {
    const keep = await add('Nell', 'Osric', '+13035550153');
    const dupe = await add('Nell', 'Osrick', '+13035550153');
    const other = await add('Nell', 'Osric', '+13035550154', '1980-01-02');
    const preview = await api.request('POST', `${P}/merge/preview`, { cookie: as.owner, body: { kind: 'pet', keepId: keep, mergeId: dupe } });
    expect(preview.json()).toEqual({ records: 1, duplicates: 0, appointments: 0, calls: 0, requests: 0, texts: 0 });
    const refused = await api.request('POST', `${P}/merge/preview`, { cookie: as.owner, body: { kind: 'household', keepId: keep, mergeId: dupe } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'merge_refused', reason: 'same_household' });
    expect((await api.request('POST', `${P}/merge`, { cookie: as.owner, body: { kind: 'pet', keepId: keep, mergeId: dupe } })).statusCode).toBe(200);
    expect((await api.request('GET', `${P}/${dupe}`, { cookie: as.staff })).statusCode).toBe(404);
    const household = await api.request('POST', `${P}/merge`, { cookie: as.owner, body: { kind: 'household', keepId: keep, mergeId: other } });
    expect(household.statusCode, household.body).toBe(200);
    const profile = (await api.request('GET', `${P}/${other}`, { cookie: as.staff })).json();
    expect(profile.phone).toBe('+13035550153');
    expect(profile.household.map((h: { id: string }) => h.id)).toEqual([keep]);
    // another clinic's record is never found for a merge
    const theirs = await new PostgresPatientDirectory(api.t.db, createPhiCipher(TEST_DATA_KEY), 'seed').create(OTHER.id, { firstName: 'Ilse', lastName: 'Varga', dob: '1979-05-05', phone: '+13035550155' });
    expect((await api.request('POST', `${P}/merge/preview`, { cookie: as.owner, body: { kind: 'pet', keepId: keep, mergeId: theirs } })).statusCode).toBe(404);
    expect((await api.request('POST', `${P}/merge`, { cookie: as.owner, body: { kind: 'household', keepId: keep, mergeId: theirs } })).statusCode).toBe(404);
    expect((await api.request('POST', `${P}/${theirs}/delete/preview`, { cookie: as.owner, body: {} })).statusCode).toBe(404);
  });
});
