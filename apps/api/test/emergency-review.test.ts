import { DEMO_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const NOW = new Date('2026-10-20T15:00:00Z');
let api: Awaited<ReturnType<typeof startApi>>;
let admin: string;
let staff: string;

beforeAll(async () => {
  api = await startApi({ demoMode: false, now: () => NOW });
  admin = await api.signIn('olga@maple.example', true);
  staff = await api.signIn('ana@maple.example', true);
});
afterAll(() => api.close());

describe('the emergency review', () => {
  it('shows the lists and the words, records who reviewed them, and keeps the review through Settings', async () => {
    const before = (await api.request('GET', `${C}/emergency-review`, { cookie: staff })).json();
    expect(before).toMatchObject({ review: null, current: false });
    expect(before.sheet.person.length).toBeGreaterThan(5);
    expect(before.sheet.says.person.en).toContain('911');

    expect((await api.request('POST', `${C}/emergency-review`, { cookie: staff, body: { reviewerName: 'Dr. Ana', reviewerRole: 'Physician' } })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/emergency-review`, { cookie: admin, body: { reviewerName: 'D', reviewerRole: '' } })).statusCode).toBe(422);
    const done = await api.request('POST', `${C}/emergency-review`, { cookie: admin, body: { reviewerName: 'Dr. Priya Okafor', reviewerRole: 'Physician, MD' } });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ current: true, review: { reviewerName: 'Dr. Priya Okafor', reviewerRole: 'Physician, MD', reviewedAt: NOW.toISOString(), version: before.sheet.version } });

    const audit = (await api.request('GET', `${C}/audit`, { cookie: admin })).json();
    expect(audit.entries[0]).toMatchObject({ action: 'clinic.emergency_list.reviewed' });

    // Settings cannot remove or forge it
    const settings = (await api.request('GET', `${C}/settings`, { cookie: admin })).json();
    const without = { ...settings, emergencyReview: undefined };
    expect((await api.request('PUT', `${C}/settings`, { cookie: admin, body: without })).json().emergencyReview).toMatchObject({ reviewerName: 'Dr. Priya Okafor' });
    const forged = { ...settings, emergencyReview: { ...settings.emergencyReview, reviewerName: 'Someone Else' } };
    expect((await api.request('PUT', `${C}/settings`, { cookie: admin, body: forged })).json().emergencyReview.reviewerName).toBe('Dr. Priya Okafor');
  });
});
