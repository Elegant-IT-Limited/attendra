import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MailRequest } from '../src/mail-hook';
import { addMember } from '../src/members';
import { OTHER, PASSWORD, startApi } from './helpers';

// a hosted deployment: the hosting layer emails, so every address is invited the same way
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const ME = '/api/v1/me/invitations';
const mails: MailRequest[] = [];
let now = new Date('2026-11-06T15:00:00Z');
let api: Awaited<ReturnType<typeof startApi>>;
let owner: string;
let admin: string;
beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional', mails, now: () => now });
  owner = await api.signIn('omar@maple.example');
  admin = await api.signIn('olga@maple.example');
});
afterAll(() => api.close());

const invite = (cookie: string, body: object) => api.request('POST', `${C}/members`, { cookie, body });
const pending = async () => ((await api.request('GET', `${C}/invitations`, { cookie: owner })).json().invitations as { id: string; email: string; role: string; invitedBy: string; expiresAt: string }[])
  .sort((a, b) => a.email.localeCompare(b.email));
const mine = async (cookie: string) => (await api.request('GET', ME, { cookie })).json().invitations as { id: string; clinicId: string; clinicName: string; role: string }[];
const clinicsOf = async (cookie: string) => (await api.request('GET', '/api/v1/me', { cookie })).json().clinics.map((c: { id: string; role: string }) => `${c.id}:${c.role}`);
const audits = async (clinicId = DEMO_CLINIC.id) => (await api.t.db.execute(sql`select action, actor, entity_id, at from audit_logs
  where clinic_id = ${clinicId} and entity = 'invitation' order by id`)).rows as { action: string; actor: string; entity_id: string; at: string }[];

describe('an invitation never says whether the email has an Attendra login', () => {
  it('a new address and a login at another practice get the same answer, the same pending row and an email each', async () => {
    const known = await invite(owner, { name: 'Otto', email: 'Otto@Other.example', role: 'staff' });
    const fresh = await invite(owner, { name: 'Nell New', email: 'nell@maple.example', role: 'staff' });
    expect([known.statusCode, fresh.statusCode]).toEqual([201, 201]);
    expect(known.json()).toEqual({ status: 'invite_sent', email: 'otto@other.example' });
    expect(fresh.json()).toEqual({ status: 'invite_sent', email: 'nell@maple.example' });
    // neither is on the team yet; both wait, in the same shape
    const members = (await api.request('GET', `${C}/members`, { cookie: owner })).json().members.map((m: { email: string }) => m.email);
    expect(members).not.toContain('otto@other.example');
    expect(members).not.toContain('nell@maple.example');
    const rows = await pending();
    expect(rows.map((r) => [r.email, r.role, r.invitedBy])).toEqual([['nell@maple.example', 'staff', 'Omar Owner'], ['otto@other.example', 'staff', 'Omar Owner']]);
    expect(Object.keys(rows[0]!)).toEqual(Object.keys(rows[1]!));
    expect(new Date(rows[0]!.expiresAt).getTime() - now.getTime()).toBe(7 * 86_400_000);
    // the emails: the clinic and the role in words; a link to set a password only for the account that has none
    const [toOtto, toNell] = mails.filter((m) => m.type === 'team_invitation');
    expect(toOtto).toMatchObject({ type: 'team_invitation', email: 'otto@other.example', name: 'Otto Other', clinicName: DEMO_CLINIC.name, role: 'Front desk', url: 'http://localhost:3000/' });
    expect(toOtto).not.toHaveProperty('setPasswordUrl');
    expect(toNell).toMatchObject({ email: 'nell@maple.example', name: 'Nell New', clinicName: DEMO_CLINIC.name, role: 'Front desk' });
    expect(new URL((toNell as { setPasswordUrl: string }).setPasswordUrl).pathname).toBe('/reset-password');
  });

  it('someone already on the team is told so: that is the team\'s own list', async () => {
    const res = await invite(owner, { email: 'ana@maple.example', role: 'staff' });
    expect([res.statusCode, res.json().error]).toEqual([409, 'already_member']);
  });

  it('sending it again renews the one invitation instead of adding a second', async () => {
    const before = await pending();
    now = new Date(now.getTime() + 60_000);
    expect((await invite(admin, { email: 'otto@other.example', role: 'viewer' })).statusCode).toBe(201);
    const after = await pending();
    expect(after.length).toBe(before.length);
    expect(after.find((r) => r.email === 'otto@other.example')).toMatchObject({ id: before.find((r) => r.email === 'otto@other.example')!.id, role: 'viewer', invitedBy: 'Olga Admin' });
    expect((await invite(admin, { email: 'otto@other.example', role: 'staff' })).statusCode).toBe(201);
  });
});

describe('accepting', () => {
  it('adds the membership with the invited role, and the clinic switcher lists both clinics', async () => {
    const otto = await api.signIn('otto@other.example');
    const [inv] = await mine(otto);
    expect(inv).toMatchObject({ clinicId: DEMO_CLINIC.id, clinicName: DEMO_CLINIC.name, role: 'staff' });
    // someone else cannot answer it, even with its id
    const ana = await api.signIn('ana@maple.example');
    expect((await api.request('POST', `${ME}/${inv!.id}/accept`, { cookie: ana })).statusCode).toBe(404);
    const res = await api.request('POST', `${ME}/${inv!.id}/accept`, { cookie: otto });
    expect([res.statusCode, res.json()]).toEqual([200, { clinicId: DEMO_CLINIC.id }]);
    expect((await clinicsOf(otto)).sort()).toEqual([`${DEMO_CLINIC.id}:staff`, `${OTHER.id}:owner`].sort());
    expect(await mine(otto)).toEqual([]);
    expect((await pending()).map((r) => r.email)).not.toContain('otto@other.example');
    // and only once
    expect((await api.request('POST', `${ME}/${inv!.id}/accept`, { cookie: otto })).statusCode).toBe(404);
    const rows = await audits();
    expect(rows.filter((r) => r.entity_id === inv!.id).map((r) => [r.action, r.actor])).toEqual([
      ['member.invited:staff', `user:${api.users.owner}`], ['member.invited:viewer', `user:${api.users.admin}`], ['member.invited:staff', `user:${api.users.admin}`],
      ['member.invite.accepted', `user:${api.users.outsider}`],
    ]);
    // the other practice's log is not told about it
    expect(await audits(OTHER.id)).toEqual([]);
  });

  it('a new address sets a password with the emailed link, signs in and accepts', async () => {
    const link = new URL((mails.find((m) => m.type === 'team_invitation' && m.email === 'nell@maple.example') as { setPasswordUrl: string }).setPasswordUrl);
    expect((await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'nell@maple.example', password: 'nothing works before the link' } })).statusCode).toBe(401);
    const set = await api.request('POST', '/api/auth/reset-password', { body: { token: link.searchParams.get('token'), newPassword: 'nell chose this password' } });
    expect(set.statusCode).toBe(200);
    const res = await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'nell@maple.example', password: 'nell chose this password' } });
    const nell = ([] as string[]).concat(res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
    const [inv] = await mine(nell);
    expect((await api.request('POST', `${ME}/${inv!.id}/accept`, { cookie: nell })).statusCode).toBe(200);
    expect(await clinicsOf(nell)).toEqual([`${DEMO_CLINIC.id}:staff`]);
  });
});

describe('each clinic keeps to its own team', () => {
  it('never resets the password or the two-step sign-in of someone who also works elsewhere', async () => {
    for (const path of ['reset-password', 'reset-two-factor']) {
      const res = await api.request('POST', `${C}/members/${api.users.outsider}/${path}`, { cookie: owner });
      expect([res.statusCode, res.json().error]).toEqual([409, 'other_organizations']);
    }
    expect((await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'otto@other.example', password: PASSWORD } })).statusCode).toBe(200);
  });

  it('another practice cannot see or cancel this team\'s invitations', async () => {
    await invite(owner, { email: 'vera@maple.example', role: 'viewer' });
    const [inv] = (await pending()).filter((r) => r.email === 'vera@maple.example');
    const otto = await api.signIn('otto@other.example');
    // Otto is on this team now, as front desk: not a manager here
    expect((await api.request('GET', `${C}/invitations`, { cookie: otto })).statusCode).toBe(403);
    expect((await api.request('DELETE', `/api/v1/clinics/${OTHER.id}/invitations/${inv!.id}`, { cookie: otto })).statusCode).toBe(404);
    expect((await pending()).map((r) => r.email)).toContain('vera@maple.example');
  });

  it('removing someone from this clinic leaves their other one', async () => {
    const otto = await api.signIn('otto@other.example');
    expect((await api.request('DELETE', `${C}/members/${api.users.outsider}`, { cookie: owner })).statusCode).toBe(204);
    expect(await clinicsOf(otto)).toEqual([`${OTHER.id}:owner`]);
  });
});

describe('declining, cancelling and lapsing', () => {
  it('declining ends it, in both lists, with an audit row', async () => {
    const vera = await api.signIn('vera@maple.example').catch(() => null);
    expect(vera).toBeNull(); // Vera has no account yet: made by the invitation, with no password
    const userId = await addMember(api.auth, api.t.db, { email: 'dee@other.example', name: 'Dee Decline', password: PASSWORD, orgId: 'org_other', role: 'staff' });
    await invite(owner, { email: 'dee@other.example', role: 'staff' });
    const dee = await api.signIn('dee@other.example');
    const [inv] = await mine(dee);
    expect((await api.request('POST', `${ME}/${inv!.id}/decline`, { cookie: dee })).statusCode).toBe(204);
    expect(await mine(dee)).toEqual([]);
    expect((await pending()).map((r) => r.email)).not.toContain('dee@other.example');
    expect((await api.request('POST', `${ME}/${inv!.id}/accept`, { cookie: dee })).statusCode).toBe(404);
    expect(await clinicsOf(dee)).toEqual([`${OTHER.id}:staff`]);
    expect((await audits()).filter((r) => r.entity_id === inv!.id).map((r) => [r.action, r.actor]).at(-1)).toEqual(['member.invite.declined', `user:${userId}`]);
  });

  it('cancelling from Team ends it: the person no longer sees it, and it cannot be accepted', async () => {
    await invite(owner, { email: 'dee@other.example', role: 'admin' });
    const [inv] = (await pending()).filter((r) => r.email === 'dee@other.example');
    const dee = await api.signIn('dee@other.example');
    expect((await mine(dee)).map((i) => i.id)).toEqual([inv!.id]);
    expect((await api.request('DELETE', `${C}/invitations/${inv!.id}`, { cookie: admin })).statusCode).toBe(204);
    expect((await api.request('DELETE', `${C}/invitations/${inv!.id}`, { cookie: admin })).statusCode).toBe(404);
    expect(await mine(dee)).toEqual([]);
    expect((await api.request('POST', `${ME}/${inv!.id}/accept`, { cookie: dee })).statusCode).toBe(404);
    expect((await audits()).filter((r) => r.entity_id === inv!.id).map((r) => [r.action, r.actor])).toEqual([
      ['member.invited:admin', `user:${api.users.owner}`], ['member.invite.canceled', `user:${api.users.admin}`],
    ]);
  });

  it('7 days with no answer ends it, with an audit row dated when it lapsed', async () => {
    await invite(owner, { email: 'dee@other.example', role: 'staff' });
    const [inv] = (await pending()).filter((r) => r.email === 'dee@other.example');
    const dee = await api.signIn('dee@other.example');
    now = new Date(now.getTime() + 7 * 86_400_000 - 60_000);
    expect((await mine(dee)).map((i) => i.id)).toEqual([inv!.id]);
    now = new Date(now.getTime() + 2 * 60_000);
    // reading never writes: the lapsed invitation is left out by its date, still pending, with no audit row yet
    const state = async () => ({
      status: ((await api.t.db.execute(sql`select status from invitations where id = ${inv!.id}`)).rows[0] as { status: string }).status,
      audits: (await audits()).length,
    });
    const before = await state();
    expect(await mine(dee)).toEqual([]);
    expect((await pending()).map((r) => r.email)).not.toContain('dee@other.example');
    expect(await state()).toEqual(before);
    expect(before.status).toBe('pending');
    expect((await api.request('POST', `${ME}/${inv!.id}/accept`, { cookie: dee })).statusCode).toBe(404);
    const lapsed = (await audits()).filter((r) => r.entity_id === inv!.id).at(-1)!;
    expect([lapsed.action, lapsed.actor, new Date(lapsed.at).toISOString()]).toEqual(['member.invite.expired', 'system', inv!.expiresAt]);
    // the Vera invitation sent earlier lapsed too
    expect((await pending()).map((r) => r.email)).not.toContain('vera@maple.example');
  });
});

describe('owners', () => {
  it('a manager cannot invite an owner, renew or cancel an owner\'s invitation; an owner can', async () => {
    const refused = await invite(admin, { email: 'olive@maple.example', role: 'owner' });
    expect([refused.statusCode, refused.json().error]).toEqual([403, 'forbidden']);
    expect((await pending()).map((r) => r.email)).not.toContain('olive@maple.example');
    expect((await invite(owner, { email: 'olive@maple.example', role: 'owner' })).statusCode).toBe(201);
    expect((await invite(admin, { email: 'olive@maple.example', role: 'staff' })).statusCode).toBe(403);
    const [inv] = (await pending()).filter((r) => r.email === 'olive@maple.example');
    expect(inv!.role).toBe('owner');
    expect((await api.request('DELETE', `${C}/invitations/${inv!.id}`, { cookie: admin })).statusCode).toBe(403);
    expect((await api.request('DELETE', `${C}/invitations/${inv!.id}`, { cookie: owner })).statusCode).toBe(204);
  });

  it('front desk and viewers cannot invite or see invitations', async () => {
    const ana = await api.signIn('ana@maple.example');
    expect((await invite(ana, { email: 'x@maple.example', role: 'staff' })).statusCode).toBe(403);
    expect((await api.request('GET', `${C}/invitations`, { cookie: ana })).statusCode).toBe(403);
  });
});
