import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MailRequest } from '../src/mail-hook';
import { PASSWORD, startApi, totp } from './helpers';

const TOKEN = 'a-provisioning-token-for-tests-0123456789';
const P = '/api/v1/provisioning';
const mails: MailRequest[] = [];
let api: Awaited<ReturnType<typeof startApi>>;
let owner: string;
beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional', mails, provisioningToken: TOKEN, accountLinks: [{ label: 'Billing', href: '/account/billing/{clinicId}' }] });
  owner = await api.signIn('omar@maple.example');
});
afterAll(() => api.close());

const signIn = (email: string, password: string) => api.request('POST', '/api/auth/sign-in/email', { body: { email, password } });
const cookieOf = (res: { headers: Record<string, unknown> }) => ([] as string[]).concat((res.headers['set-cookie'] as string[] | string | undefined) ?? []).map((c) => c.split(';')[0]).join('; ');
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;

describe('what the sign-in page is told it can offer', () => {
  it('forgot password, sign-up and a new confirmation link on a hosted deployment', async () => {
    expect((await api.request('GET', '/api/v1/health')).json()).toMatchObject({ passwordReset: true, signupUrl: '/account/signup', resendUrl: '/account/resend' });
  });

  it('how long the dashboard waits without activity before signing out: 15 minutes unless the deployment says otherwise', async () => {
    expect((await api.request('GET', '/api/v1/me', { cookie: owner })).json().idleMinutes).toBe(15);
  });
});

describe('forgot password', () => {
  it('emails a one-hour link through the hosting layer, the same answer for any address, and the link sets a new password once', async () => {
    const asked = await api.request('POST', '/api/auth/request-password-reset', { body: { email: 'ana@maple.example' } });
    const stranger = await api.request('POST', '/api/auth/request-password-reset', { body: { email: 'nobody@nowhere.example' } });
    expect(asked.statusCode).toBe(200);
    expect(stranger.statusCode).toBe(200);
    expect(stranger.json()).toEqual(asked.json());
    expect(mails.map((m) => m.email)).toEqual(['ana@maple.example']);
    const url = new URL(mails[0]!.url);
    expect(url.pathname).toBe('/reset-password');
    const token = url.searchParams.get('token')!;

    const before = await api.signIn('ana@maple.example');
    const reset = await api.request('POST', '/api/auth/reset-password', { body: { token, newPassword: 'a brand new password for ana' } });
    expect(reset.statusCode).toBe(200);
    // every session ends, the old password stops working, the new one works; the link works once
    expect((await api.request('GET', '/api/v1/me', { cookie: before })).statusCode).toBe(401);
    expect((await signIn('ana@maple.example', PASSWORD)).statusCode).toBe(401);
    expect((await signIn('ana@maple.example', 'a brand new password for ana')).statusCode).toBe(200);
    expect((await api.request('POST', '/api/auth/reset-password', { body: { token, newPassword: 'yet another password here' } })).statusCode).toBe(400);
  });

  it('a reset ends a temporary password too', async () => {
    const added = (await api.request('POST', `${C}/members`, { cookie: owner, body: { name: 'Tess Temp', email: 'tess@maple.example', role: 'staff' } })).json();
    expect(added.temporaryPassword).toEqual(expect.any(String));
    await api.request('POST', '/api/auth/request-password-reset', { body: { email: 'tess@maple.example' } });
    const token = new URL(mails.at(-1)!.url).searchParams.get('token')!;
    expect((await api.request('POST', '/api/auth/reset-password', { body: { token, newPassword: 'tess picked her own password' } })).statusCode).toBe(200);
    const cookie = cookieOf(await signIn('tess@maple.example', 'tess picked her own password'));
    expect((await api.request('GET', '/api/v1/me', { cookie })).json().user.mustChangePassword).toBe(false);
  });
});

describe('an expired temporary password', () => {
  it('is only reported to someone who typed it right: a wrong password gets the ordinary answer', async () => {
    const added = (await api.request('POST', `${C}/members`, { cookie: owner, body: { name: 'Exp Ired', email: 'exp@maple.example', role: 'staff' } })).json();
    await api.t.db.execute(sql`update auth_users set temporary_password_expires_at = now() - interval '1 hour' where email = 'exp@maple.example'`);
    const wrong = await signIn('exp@maple.example', 'not the password at all');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toMatch(/temporary_password_expired/);
    const right = await signIn('exp@maple.example', added.temporaryPassword);
    expect([right.statusCode, right.json().error]).toEqual([401, 'temporary_password_expired']);
    // and no session is left open by it
    const sessions = (await api.t.db.execute(sql`select count(*)::int as n from auth_sessions s join auth_users u on u.id = s.user_id where u.email = 'exp@maple.example'`)).rows[0] as { n: number };
    expect(sessions.n).toBe(0);
  });
});

describe('a lost phone', () => {
  it('a manager turns off a person\'s two-step sign-in; they sign in with their password and set it up again', async () => {
    const vic = await api.signIn('vic@maple.example', true);
    expect((await api.request('GET', '/api/v1/me', { cookie: vic })).json().user.twoFactorEnabled).toBe(true);
    expect((await api.request('POST', `${C}/members/${api.users.viewer}/reset-two-factor`, { cookie: owner })).statusCode).toBe(204);
    expect((await api.request('GET', '/api/v1/me', { cookie: vic })).statusCode).toBe(401); // signed out everywhere
    const again = await signIn('vic@maple.example', PASSWORD);
    expect(again.statusCode).toBe(200);
    expect(again.json().twoFactorRedirect).toBeFalsy();
    const audit = (await api.t.db.execute(sql`select count(*)::int as n from audit_logs where action = 'member.two_factor.reset'`)).rows[0] as { n: number };
    expect(audit.n).toBeGreaterThan(0);
    // nobody resets their own, and a manager never resets an owner's
    expect((await api.request('POST', `${C}/members/${api.users.owner}/reset-two-factor`, { cookie: owner })).statusCode).toBe(403);
    const olga = await api.signIn('olga@maple.example');
    expect((await api.request('POST', `${C}/members/${api.users.owner}/reset-two-factor`, { cookie: olga })).statusCode).toBe(403);
  });

  it('a signed-in person replaces their phone: two-step off with their password, then set up again', async () => {
    let me = await api.signIn('omar@maple.example');
    const enable = await api.request('POST', '/api/auth/two-factor/enable', { cookie: me, body: { password: PASSWORD } });
    const verified = await api.request('POST', '/api/auth/two-factor/verify-totp', { cookie: me, body: { code: totp(enable.json().totpURI) } });
    me = cookieOf(verified) || me;
    expect((await api.request('POST', '/api/auth/two-factor/disable', { cookie: me, body: { password: 'wrong password entirely' } })).statusCode).not.toBe(200);
    const off = await api.request('POST', '/api/auth/two-factor/disable', { cookie: me, body: { password: PASSWORD } });
    expect(off.statusCode).toBe(200);
    me = cookieOf(off) || me; // the session is renewed
    const now = await api.request('GET', '/api/v1/me', { cookie: me });
    expect(now.json().user?.twoFactorEnabled, now.body).toBe(false);
    const again = await api.request('POST', '/api/auth/two-factor/enable', { cookie: me, body: { password: PASSWORD } });
    expect(again.statusCode).toBe(200);
    expect(again.json().totpURI).not.toBe(enable.json().totpURI);
  });

  it('support resets it for someone with nobody to ask', async () => {
    expect((await api.request('POST', `${P}/users/reset-two-factor`, { authorization: `Bearer ${TOKEN}`, body: { email: 'omar@maple.example' } })).statusCode).toBe(204);
    expect((await api.request('POST', `${P}/users/reset-two-factor`, { authorization: 'Bearer wrong', body: { email: 'omar@maple.example' } })).statusCode).toBe(401);
  });
});

describe('someone removed, added back', () => {
  // a fresh session: the tests above sign the owner out everywhere
  beforeAll(async () => { owner = await api.signIn('omar@maple.example'); });
  it('gets a new temporary password instead of "already uses Attendra"', async () => {
    const added = (await api.request('POST', `${C}/members`, { cookie: owner, body: { name: 'Rhea Return', email: 'rhea@maple.example', role: 'staff' } })).json();
    await signIn('rhea@maple.example', added.temporaryPassword);
    expect((await api.request('DELETE', `${C}/members/${added.userId}`, { cookie: owner })).statusCode).toBe(204);
    const back = await api.request('POST', `${C}/members`, { cookie: owner, body: { name: 'Rhea Return', email: 'rhea@maple.example', role: 'staff' } });
    expect(back.statusCode).toBe(201);
    expect(back.json().userId).toBe(added.userId);
    expect(back.json().temporaryPassword).not.toBe(added.temporaryPassword);
    expect((await signIn('rhea@maple.example', back.json().temporaryPassword)).statusCode).toBe(200);
  });

  it('only by the practice that removed them: another one cannot take over a login nobody uses', async () => {
    const opened = (await api.request('POST', `${P}/accounts`, { authorization: `Bearer ${TOKEN}`, body: { organization: { name: 'Quarry Vets' }, clinic: { name: 'Quarry Vets', timezone: 'America/Denver', industry: 'vet', phone: '+13035550122' }, owner: { name: 'Quinn Quarry', email: 'quinn@quarry.example', password: 'quinn has a long password' } } })).json();
    await api.request('POST', `${P}/email-confirmations`, { authorization: `Bearer ${TOKEN}`, body: { email: 'quinn@quarry.example' } });
    const quinn = cookieOf(await signIn('quinn@quarry.example', 'quinn has a long password'));
    const rhea = (await api.request('GET', `${C}/members`, { cookie: owner })).json().members.find((m: { email: string }) => m.email === 'rhea@maple.example');
    expect((await api.request('DELETE', `${C}/members/${rhea.userId}`, { cookie: owner })).statusCode).toBe(204);
    const elsewhere = await api.request('POST', `/api/v1/clinics/${opened.clinicId}/members`, { cookie: quinn, body: { name: 'Rhea', email: 'rhea@maple.example', role: 'staff' } });
    expect([elsewhere.statusCode, elsewhere.json().error]).toEqual([409, 'account_exists']);
    expect(elsewhere.json().temporaryPassword).toBeUndefined();
    expect((await api.request('POST', `${C}/members`, { cookie: owner, body: { name: 'Rhea Return', email: 'rhea@maple.example', role: 'staff' } })).statusCode).toBe(201);
  });

  it('someone at another practice: a neutral answer that names nothing', async () => {
    const res = await api.request('POST', `${C}/members`, { cookie: owner, body: { name: 'Otto', email: 'otto@other.example', role: 'staff' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).not.toMatch(/practice|uses Attendra/i);
  });
});

describe('a sign-up the hosting layer could not finish', () => {
  const account = (email: string, extra: object = {}) => ({ organization: { name: 'Pine Vets' }, clinic: { name: 'Pine Vets', timezone: 'America/Denver', industry: 'vet', phone: '+13035550111' }, owner: { name: 'Pia Pine', email, password: 'pia has a long password' }, ...extra });
  const open = (body: object) => api.request('POST', `${P}/accounts`, { authorization: `Bearer ${TOKEN}`, body });

  it('says whether an address taken is confirmed, and removes an unconfirmed one so the address can sign up again', async () => {
    const first = await open(account('pia@pine.example'));
    expect(first.statusCode).toBe(201);
    expect([(await open(account('pia@pine.example'))).statusCode, (await open(account('pia@pine.example'))).json()]).toEqual([409, { error: 'email_taken', confirmed: false }]);
    // while its link may still be opened, nobody else's sign-up replaces it
    expect((await open(account('pia@pine.example', { replaceUnconfirmed: true }))).json()).toEqual({ error: 'email_taken', confirmed: false });
    // once the link has run out, a new sign-up is opened in its place
    await api.t.db.execute(sql`update auth_users set created_at = now() - interval '49 hours' where email = 'pia@pine.example'`);
    const replaced = await open(account('pia@pine.example', { replaceUnconfirmed: true }));
    expect(replaced.statusCode).toBe(201);
    expect(replaced.json().organizationId).not.toBe(first.json().organizationId);
    const orgs = (await api.t.db.execute(sql`select count(*)::int as n from organizations where id = ${first.json().organizationId}`)).rows[0] as { n: number };
    expect(orgs.n).toBe(0);
    // removed outright, after a failure on the hosting side
    expect((await api.request('DELETE', `${P}/accounts/unconfirmed`, { authorization: `Bearer ${TOKEN}`, body: { email: 'pia@pine.example' } })).statusCode).toBe(204);
    expect((await open(account('pia@pine.example'))).statusCode).toBe(201);
  });

  it('never touches a confirmed account', async () => {
    expect((await open(account('omar@maple.example', { replaceUnconfirmed: true }))).json()).toEqual({ error: 'email_taken', confirmed: true });
    expect((await api.request('DELETE', `${P}/accounts/unconfirmed`, { authorization: `Bearer ${TOKEN}`, body: { email: 'omar@maple.example' } })).statusCode).toBe(409);
    expect((await signIn('omar@maple.example', PASSWORD)).statusCode).toBe(200);
  });
});
