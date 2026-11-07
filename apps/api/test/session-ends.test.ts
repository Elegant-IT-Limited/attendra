import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_HOURS } from '../src/auth';
import { startApi } from './helpers';

/**
 * A session ends 12 hours after it was last used, not 12 hours after sign-in: a request
 * more than an hour after the last renewal moves the end, and the browser gets the
 * renewed cookie with the answer. /me says when the session ends, for the dashboard's
 * warning.
 */
let api: Awaited<ReturnType<typeof startApi>>;
beforeAll(async () => { api = await startApi({ demoMode: false, twoFactor: 'optional' }); });
afterAll(() => api.close());

const HOUR = 3_600_000;
const sessionCookie = (res: { headers: Record<string, unknown> }) =>
  ([] as string[]).concat((res.headers['set-cookie'] as string[] | string | undefined) ?? []).find((c) => /session_token=/.test(c));
const endOf = async (userEmail: string) => {
  const rows = await api.t.db.execute<{ expires_at: Date | string }>(sql`select s.expires_at from auth_sessions s join auth_users u on u.id = s.user_id where u.email = ${userEmail} order by s.created_at desc limit 1`);
  return new Date(rows.rows[0]!.expires_at).getTime();
};
/** The session as if it had been renewed `hours` ago: its end is 12 hours after that. */
const renewedAgo = (userEmail: string, hours: number) => api.t.db.execute(sql`
  update auth_sessions set expires_at = now() + make_interval(secs => ${(SESSION_HOURS - hours) * 3600}), updated_at = now() - make_interval(secs => ${hours * 3600})
  where user_id = (select id from auth_users where email = ${userEmail})`);

describe('a session in use does not end', () => {
  it('within the hour after its last renewal nothing is written, and /me says when it ends', async () => {
    const cookie = await api.signIn('omar@maple.example');
    const res = await api.request('GET', '/api/v1/me', { cookie });
    expect(res.statusCode).toBe(200);
    expect(sessionCookie(res)).toBeUndefined();
    const end = await endOf('omar@maple.example');
    expect(Date.parse(res.json().expiresAt)).toBe(end);
    expect(end - Date.now()).toBeGreaterThan((SESSION_HOURS - 0.1) * HOUR);
  });

  it('used more than an hour after its last renewal, it ends 12 hours from now, and the browser gets the renewed cookie', async () => {
    const cookie = await api.signIn('ana@maple.example');
    await renewedAgo('ana@maple.example', 11.5); // half an hour left: the dashboard would be warning now
    const before = await endOf('ana@maple.example');
    expect(before - Date.now()).toBeLessThan(HOUR);
    const res = await api.request('GET', `/api/v1/clinics/${DEMO_CLINIC.id}/tasks/count`, { cookie });
    expect(res.statusCode).toBe(200);
    const renewed = sessionCookie(res);
    expect(renewed).toMatch(new RegExp(`Max-Age=${SESSION_HOURS * 3600}`));
    const after = await endOf('ana@maple.example');
    expect(after - Date.now()).toBeGreaterThan((SESSION_HOURS - 0.1) * HOUR);
    // the same session, still signed in, and /me shows the new end
    const me = await api.request('GET', '/api/v1/me', { cookie });
    expect(me.statusCode).toBe(200);
    expect(Date.parse(me.json().expiresAt)).toBe(after);
  });

  it('past its end, it is over: the next request is told so', async () => {
    const cookie = await api.signIn('olga@maple.example');
    await renewedAgo('olga@maple.example', SESSION_HOURS + 0.01);
    const res = await api.request('GET', '/api/v1/me', { cookie });
    expect(res.statusCode).toBe(401);
  });
});
