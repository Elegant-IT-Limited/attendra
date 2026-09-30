import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, startApi, totp } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const NEW_PASSWORD = 'a password only Nia knows';
let now = new Date();
const logs: string[] = [];
let api: Awaited<ReturnType<typeof startApi>>;
let admin: string;
const issued: string[] = [];

const cookieFrom = (setCookie: string | string[] | undefined) => ([] as string[]).concat(setCookie ?? []).map((c) => c.split(';')[0]).join('; ');
const signIn = (email: string, password: string) => api.request('POST', '/api/auth/sign-in/email', { body: { email, password } });

beforeAll(async () => {
  api = await startApi({ demoMode: false, now: () => now, logs });
  admin = await api.signIn('olga@maple.example', true);
});
afterAll(() => api.close());

describe('a temporary password', () => {
  let nia: string;
  let password: string;
  let userId: string;

  it('is issued once when a manager adds someone, with a 72-hour expiry', async () => {
    const res = await api.request('POST', `${C}/members`, { cookie: admin, body: { name: 'Nia New', email: 'nia@maple.example', role: 'staff' } });
    expect(res.statusCode).toBe(201);
    ({ userId, temporaryPassword: password } = res.json());
    issued.push(password);
    expect(res.json().expiresInHours).toBe(72);
    const [row] = (await api.t.db.execute(sql`select must_change_password, temporary_password_expires_at from auth_users where id = ${userId}`)).rows as { must_change_password: boolean; temporary_password_expires_at: string }[];
    expect(row!.must_change_password).toBe(true);
    expect(new Date(row!.temporary_password_expires_at).getTime() - now.getTime()).toBeGreaterThan(71.9 * 3_600_000);
  });

  it('signs in, and then only says who you are until it is changed', async () => {
    const res = await signIn('nia@maple.example', password);
    expect(res.statusCode).toBe(200);
    nia = cookieFrom(res.headers['set-cookie']);
    const me = (await api.request('GET', '/api/v1/me', { cookie: nia })).json();
    expect(me.user).toMatchObject({ mustChangePassword: true, twoFactorEnabled: false });
    const calls = await api.request('GET', `${C}/calls`, { cookie: nia });
    expect(calls.statusCode).toBe(403);
    expect(calls.json().error).toBe('password_change_required');
  });

  it('cannot be used to set up two-step sign-in, so whoever read it out cannot enrol for its owner', async () => {
    const res = await api.request('POST', '/api/auth/two-factor/enable', { cookie: nia, body: { password } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('password_change_required');
  });

  it('must be replaced by a different password', async () => {
    const same = await api.request('POST', '/api/auth/change-password', { cookie: nia, body: { currentPassword: password, newPassword: password } });
    expect(same.json().error).toBe('same_password');
  });

  it('works once: after the change it no longer signs in, every other session ends, and the new one works', async () => {
    const other = cookieFrom((await signIn('nia@maple.example', password)).headers['set-cookie']); // say, the manager's copy
    const res = await api.request('POST', '/api/auth/change-password', { cookie: nia, body: { currentPassword: password, newPassword: NEW_PASSWORD } });
    expect(res.statusCode).toBe(200);
    const fresh = cookieFrom(res.headers['set-cookie']) || nia;
    expect((await api.request('GET', '/api/v1/me', { cookie: other })).statusCode).toBe(401);
    expect((await signIn('nia@maple.example', password)).statusCode).toBe(401);
    expect((await signIn('nia@maple.example', NEW_PASSWORD)).statusCode).toBe(200);
    const me = (await api.request('GET', '/api/v1/me', { cookie: fresh })).json();
    expect(me.user.mustChangePassword).toBe(false);
    // and now two-step setup goes ahead, and then the clinic opens
    const enable = await api.request('POST', '/api/auth/two-factor/enable', { cookie: fresh, body: { password: NEW_PASSWORD } });
    expect(enable.statusCode).toBe(200);
    const verify = await api.request('POST', '/api/auth/two-factor/verify-totp', { cookie: fresh, body: { code: totp(enable.json().totpURI) } });
    expect(verify.statusCode).toBe(200);
    expect((await api.request('GET', `${C}/calls`, { cookie: cookieFrom(verify.headers['set-cookie']) || fresh })).statusCode).toBe(200);
  });

  it('is refused once it has expired, with a message that says what to do', async () => {
    const res = await api.request('POST', `${C}/members`, { cookie: admin, body: { name: 'Late Larry', email: 'larry@maple.example', role: 'staff' } });
    issued.push(res.json().temporaryPassword);
    now = new Date(now.getTime() + 73 * 3_600_000);
    const late = await signIn('larry@maple.example', res.json().temporaryPassword);
    expect(late.statusCode).toBe(401);
    expect(late.json()).toMatchObject({ error: 'temporary_password_expired', message: 'This temporary password has expired. Ask your practice manager to reset it.' });

    // a reset issues a new one that works, and is itself temporary
    const reset = await api.request('POST', `${C}/members/${res.json().userId}/reset-password`, { cookie: admin });
    expect(reset.statusCode).toBe(200);
    issued.push(reset.json().temporaryPassword);
    expect(reset.json().temporaryPassword).not.toBe(res.json().temporaryPassword);
    const again = await signIn('larry@maple.example', reset.json().temporaryPassword);
    expect(again.statusCode).toBe(200);
    expect((await api.request('GET', '/api/v1/me', { cookie: cookieFrom(again.headers['set-cookie']) })).json().user.mustChangePassword).toBe(true);
    const audit = (await api.t.db.execute(sql`select actor, entity_id from audit_logs where action = 'member.password.reset' and clinic_id = ${DEMO_CLINIC.id}`)).rows;
    expect(audit).toEqual([{ actor: `user:${api.users.admin}`, entity_id: res.json().userId }]);
  });

  it('a reset signs the person out everywhere, and a manager cannot reset an owner or themselves', async () => {
    const staff = await api.signIn('ana@maple.example', true);
    expect((await api.request('POST', `${C}/members/${api.users.staff}/reset-password`, { cookie: admin })).statusCode).toBe(200);
    expect((await api.request('GET', '/api/v1/me', { cookie: staff })).statusCode).toBe(401);
    expect((await api.request('POST', `${C}/members/${api.users.owner}/reset-password`, { cookie: admin })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/members/${api.users.admin}/reset-password`, { cookie: admin })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/members/${api.users.staff}/reset-password`, { cookie: await api.signIn('vic@maple.example', true) })).statusCode).toBe(403);
  });

  it('never reaches a log line', () => {
    expect(issued.length).toBeGreaterThan(2);
    const all = logs.join('\n');
    expect(all.length).toBeGreaterThan(0); // the request log did run
    for (const p of [...issued, NEW_PASSWORD, PASSWORD]) expect(all).not.toContain(p);
  });
});

describe('existing accounts', () => {
  it('an email that already has an account with another practice is refused, never added silently', async () => {
    const res = await api.request('POST', `${C}/members`, { cookie: admin, body: { name: 'Otto Other', email: 'otto@other.example', role: 'viewer' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'account_exists', message: 'This person already uses Attendra with another practice. Invitations for existing accounts are coming soon.' });
    const members = (await api.request('GET', `${C}/members`, { cookie: admin })).json().members.map((m: { email: string }) => m.email);
    expect(members).not.toContain('otto@other.example');
  });
});
