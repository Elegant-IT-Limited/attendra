import { DEMO_CLINIC } from '@attendra/core';
import { saveClinic } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MailRequest } from '../src/mail-hook';
import { startApi } from './helpers';

/**
 * Access per location (tester notes 36 and 39, findings 2, 3 and 6 of 2026-11-04): a business
 * with two locations, people invited to one of them, and every list, search, address and API
 * route of the other one closed to them. Made-up people and a made-up second location.
 */
const BRANCH = { ...DEMO_CLINIC, id: 'clinic_branch', name: 'Maple Street Branch', phoneNumbers: ['+13035550121'] };
const MAIN = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const BR = `/api/v1/clinics/${BRANCH.id}`;
const ME = '/api/v1/me/invitations';
const mails: MailRequest[] = [];
let api: Awaited<ReturnType<typeof startApi>>;
let owner: string;
let admin: string;

beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional', mails, accountLinks: [{ label: 'Plan and billing', href: '/account/billing/{clinicId}' }] });
  await saveClinic(api.t.db, 'org_demo', BRANCH);
  owner = await api.signIn('omar@maple.example');
  admin = await api.signIn('olga@maple.example');
}, 120_000);
afterAll(() => api.close());

/** A new address invited by email: it sets its password from the email and signs in. */
async function joinAs(email: string, password: string) {
  const mail = mails.filter((m) => m.type === 'team_invitation' && m.email === email).at(-1) as { setPasswordUrl: string; url: string };
  const token = new URL(mail.setPasswordUrl).searchParams.get('token');
  expect((await api.request('POST', '/api/auth/reset-password', { body: { token, newPassword: password } })).statusCode).toBe(200);
  const res = await api.request('POST', '/api/auth/sign-in/email', { body: { email, password } });
  return { cookie: ([] as string[]).concat(res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; '), inviteId: new URL(mail.url).pathname.split('/').at(-1)! };
}
const clinicsOf = async (cookie: string) => (await api.request('GET', '/api/v1/me', { cookie })).json().clinics.map((c: { id: string; role: string }) => `${c.id}:${c.role}`);

describe('an invitation to one location opens that location only', () => {
  let kai: string;
  it('the owner invites to the branch; the invitee sees the branch and only the branch', async () => {
    expect((await api.request('POST', `${BR}/members`, { cookie: owner, body: { email: 'kai@example.com', role: 'staff' } })).statusCode).toBe(201);
    // the main location is not waiting on it
    expect((await api.request('GET', `${MAIN}/invitations`, { cookie: owner })).json().invitations.map((i: { email: string }) => i.email)).not.toContain('kai@example.com');
    const joined = await joinAs('kai@example.com', 'kai chose a long password');
    kai = joined.cookie;
    // before accepting: no clinic, the invitation waiting, and somewhere to start
    const before = (await api.request('GET', '/api/v1/me', { cookie: kai })).json();
    expect(before.clinics).toEqual([]);
    expect(before.newClinicUrl).toBe('/account/new-clinic');
    expect((await api.request('GET', `${ME}/${joined.inviteId}`, { cookie: kai })).json()).toMatchObject({ state: 'pending', clinicId: BRANCH.id, clinicName: BRANCH.name, role: 'staff', allLocations: false });
    expect((await api.request('POST', `${ME}/${joined.inviteId}/accept`, { cookie: kai })).json()).toEqual({ clinicId: BRANCH.id });
    expect(await clinicsOf(kai)).toEqual([`${BRANCH.id}:staff`]);
    // finding 2: their own name saves, whatever their role
    expect((await api.request('PATCH', '/api/v1/me', { cookie: kai, body: { name: 'Kai Branch' } })).statusCode).toBe(204);
  });

  it('every list, search, record and stream of the main location answers 404, as for a clinic that does not exist', async () => {
    const reads = ['calls', 'overview', 'appointments?from=2026-11-02&days=7', 'appointments/conflicts', 'tasks', 'tasks/count', 'tasks/waiting', 'patients', 'patients/recent',
      'settings', 'doctors', 'knowledge/documents', 'changes', `calls/${api.callId}`];
    for (const path of reads) expect((await api.request('GET', `${MAIN}/${path}`, { cookie: kai })).statusCode, path).toBe(404);
    for (const [path, body] of [['tasks/search', { status: 'open', q: 'Maria' }], ['patients/search', { q: 'Maria' }], ['appointments/cancelled', { from: '2026-11-01', to: '2026-11-30', sort: 'visit', order: 'newest' }]] as const) {
      expect((await api.request('POST', `${MAIN}/${path}`, { cookie: kai, body })).statusCode, path).toBe(404);
    }
    // and the branch is theirs
    expect((await api.request('GET', `${BR}/calls`, { cookie: kai })).statusCode).toBe(200);
  });

  it('the main location\'s team never lists them; the branch\'s does', async () => {
    const at = async (base: string) => (await api.request('GET', `${base}/members`, { cookie: owner })).json().members.map((m: { email: string }) => m.email);
    expect(await at(MAIN)).not.toContain('kai@example.com');
    expect(await at(BR)).toContain('kai@example.com');
  });

  it('a manager of the main location cannot see or manage the branch at all', async () => {
    expect((await api.request('GET', `${BR}/members`, { cookie: admin })).statusCode).toBe(404);
    expect(await clinicsOf(admin)).toEqual([`${DEMO_CLINIC.id}:admin`]);
  });

  it('the same person can then be invited to the main location with another role, and holds both', async () => {
    expect((await api.request('POST', `${MAIN}/members`, { cookie: admin, body: { email: 'kai@example.com', role: 'viewer' } })).statusCode).toBe(201);
    const [inv] = (await api.request('GET', ME, { cookie: kai })).json().invitations;
    await api.request('POST', `${ME}/${inv.id}/accept`, { cookie: kai });
    expect((await clinicsOf(kai)).sort()).toEqual([`${BRANCH.id}:staff`, `${DEMO_CLINIC.id}:viewer`].sort());
  });

  it('removed from the branch, they keep the main location', async () => {
    const id = (await api.request('GET', `${BR}/members`, { cookie: owner })).json().members.find((m: { email: string }) => m.email === 'kai@example.com').userId;
    expect((await api.request('DELETE', `${BR}/members/${id}`, { cookie: owner })).statusCode).toBe(204);
    expect(await clinicsOf(kai)).toEqual([`${DEMO_CLINIC.id}:viewer`]);
    expect((await api.request('GET', `${BR}/calls`, { cookie: kai })).statusCode).toBe(404);
  });
});

describe('every location at once', () => {
  it('only an owner sends it; one invitation to answer, every location on accept', async () => {
    expect((await api.request('POST', `${MAIN}/members`, { cookie: admin, body: { email: 'lou@example.com', role: 'staff', allLocations: true } })).statusCode).toBe(403);
    expect((await api.request('POST', `${MAIN}/members`, { cookie: owner, body: { email: 'lou@example.com', role: 'staff', allLocations: true } })).statusCode).toBe(201);
    const mail = mails.filter((m) => m.type === 'team_invitation' && m.email === 'lou@example.com').at(-1) as { clinicName: string };
    expect(mail.clinicName).toMatch(/\(2 locations\)$/);
    const lou = (await joinAs('lou@example.com', 'lou chose a long password')).cookie;
    const mine = (await api.request('GET', ME, { cookie: lou })).json().invitations;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ allLocations: true, role: 'staff' });
    expect(mine[0].locations.map((l: { id: string }) => l.id).sort()).toEqual([BRANCH.id, DEMO_CLINIC.id].sort());
    await api.request('POST', `${ME}/${mine[0].id}/accept`, { cookie: lou });
    expect((await clinicsOf(lou)).sort()).toEqual([`${BRANCH.id}:staff`, `${DEMO_CLINIC.id}:staff`].sort());
  });
});

describe('the invitation link for someone else', () => {
  it('says only that it is for another address', async () => {
    expect((await api.request('POST', `${MAIN}/members`, { cookie: owner, body: { email: 'pia@example.com', role: 'staff' } })).statusCode).toBe(201);
    const id = new URL((mails.filter((m) => m.type === 'team_invitation' && m.email === 'pia@example.com').at(-1) as { url: string }).url).pathname.split('/').at(-1)!;
    const ana = await api.signIn('ana@maple.example');
    expect((await api.request('GET', `${ME}/${id}`, { cookie: ana })).json()).toEqual({ state: 'other_address' });
    expect((await api.request('GET', `${ME}/no-such-invitation`, { cookie: ana })).json()).toEqual({ state: 'not_found' });
    expect((await api.request('GET', `${ME}/${id}`)).statusCode).toBe(401);
  });
});
