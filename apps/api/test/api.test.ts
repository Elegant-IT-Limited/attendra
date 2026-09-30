import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, PASSWORD, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
let admin: string;
let viewer: string;

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  staff = await api.signIn('ana@maple.example', true);
  admin = await api.signIn('olga@maple.example', true);
  viewer = await api.signIn('vic@maple.example', true);
});
afterAll(() => api.close());

describe('sign-in and two-factor', () => {
  it('rejects a wrong password and never creates accounts by sign-up', async () => {
    expect((await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'ana@maple.example', password: 'wrong password here' } })).statusCode).toBe(401);
    const signUp = await api.request('POST', '/api/auth/sign-up/email', { body: { email: 'new@maple.example', password: PASSWORD, name: 'New' } });
    expect(signUp.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('lets a new person see who they are, but nothing else, until two-factor is on', async () => {
    const res = await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'otto@other.example', password: PASSWORD } });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
    const me = await api.request('GET', '/api/v1/me', { cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.twoFactorEnabled).toBe(false);
    const calls = await api.request('GET', `/api/v1/clinics/${OTHER.id}/calls`, { cookie });
    expect(calls.statusCode).toBe(403);
    expect(calls.json().error).toBe('two_factor_required');
  });

  it('asks for the code on the next sign-in once two-factor is on', async () => {
    const res = await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'ana@maple.example', password: PASSWORD } });
    expect(res.json().twoFactorRedirect).toBe(true);
    const pending = ([] as string[]).concat(res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
    expect((await api.request('GET', `${C}/calls`, { cookie: pending })).statusCode).toBe(401);
  });

  it('answers the health check without a session, and nothing else', async () => {
    expect((await api.request('GET', '/api/v1/health')).json()).toEqual({ ok: true, demoMode: false });
  });

  it('answers 401 with no session at all', async () => {
    expect((await api.request('GET', '/api/v1/me')).statusCode).toBe(401);
  });
});

describe('the auth surface', () => {
  it('serves only the routes the dashboard uses; member admin stays closed', async () => {
    for (const [method, path] of [['POST', 'organization/invite-member'], ['GET', 'organization/list-members'], ['POST', 'update-user'], ['POST', 'two-factor/disable']] as const) {
      expect((await api.request(method, `/api/auth/${path}`, { cookie: admin, body: method === 'POST' ? {} : undefined })).statusCode, path).toBe(404);
    }
  });

  it('marks every API response as not cacheable', async () => {
    expect((await api.request('GET', '/api/v1/me', { cookie: staff })).headers['cache-control']).toBe('no-store');
  });
});

describe('me', () => {
  it('lists the clinics and the permissions of the role', async () => {
    const me = (await api.request('GET', '/api/v1/me', { cookie: viewer })).json();
    expect(me.clinics).toEqual([expect.objectContaining({ id: DEMO_CLINIC.id, role: 'viewer', permissions: ['calls:list', 'settings:read'] })]);
    expect(me.demoMode).toBe(false);
  });
});

describe('tenancy', () => {
  it('a clinic outside your organization is 404, for every route', async () => {
    for (const path of ['calls', `calls/${api.callId}`, 'tasks', 'settings', 'audit']) {
      expect((await api.request('GET', `/api/v1/clinics/${OTHER.id}/${path}`, { cookie: admin })).statusCode, path).toBe(404);
    }
    expect((await api.request('POST', `/api/v1/clinics/${OTHER.id}/tasks/${api.taskId}/claim`, { cookie: admin })).statusCode).toBe(404);
  });
});

describe('roles', () => {
  it('a viewer sees the call list and settings, never a transcript, the queue or the audit trail', async () => {
    expect((await api.request('GET', `${C}/calls`, { cookie: viewer })).statusCode).toBe(200);
    expect((await api.request('GET', `${C}/settings`, { cookie: viewer })).statusCode).toBe(200);
    for (const path of [`calls/${api.callId}`, 'tasks', 'audit']) {
      expect((await api.request('GET', `${C}/${path}`, { cookie: viewer })).statusCode, path).toBe(403);
    }
  });

  it('staff cannot change settings or read the audit trail', async () => {
    expect((await api.request('PUT', `${C}/settings`, { cookie: staff, body: DEMO_CLINIC })).statusCode).toBe(403);
    expect((await api.request('GET', `${C}/audit`, { cookie: staff })).statusCode).toBe(403);
  });
});

describe('calls', () => {
  it('lists calls with no patient data in them', async () => {
    const res = await api.request('GET', `${C}/calls?limit=10`, { cookie: staff });
    expect(res.json()).toMatchObject({ calls: [{ id: api.callId, outcome: 'task_created', voiceSeconds: 48 }], next: null });
    expect(res.body).not.toContain('Maria');
  });

  it('shows the transcript to staff and records that they looked', async () => {
    const res = await api.request('GET', `${C}/calls/${api.callId}`, { cookie: staff });
    expect(res.json().transcript[0].text).toContain('lisinopril');
    const rows = (await api.t.db.execute(sql`select actor from audit_logs where action = 'call.transcript.viewed'`)).rows;
    expect(rows).toEqual([{ actor: `user:${api.users.staff}` }]);
  });

  it('answers 404 for an unknown or malformed call id', async () => {
    expect((await api.request('GET', `${C}/calls/00000000-0000-4000-8000-000000000000`, { cookie: staff })).statusCode).toBe(404);
    expect((await api.request('GET', `${C}/calls/not-a-uuid`, { cookie: staff })).statusCode).toBe(404);
  });

  it('pages through calls that started in the same instant without skipping or repeating any', async () => {
    const ids = (await api.t.db.execute(sql`insert into calls (clinic_id, openai_session_id, started_at)
      select ${DEMO_CLINIC.id}, 'live_same_' || g, '2026-01-01T00:00:00.123456Z' from generate_series(1, 3) g returning id`)).rows.map((r: unknown) => (r as { id: string }).id);
    const seen: string[] = [];
    let url = `${C}/calls?limit=2`;
    for (;;) {
      const page = (await api.request('GET', url, { cookie: staff })).json();
      seen.push(...page.calls.map((c: { id: string }) => c.id));
      if (!page.next) break;
      url = `${C}/calls?limit=2&before=${page.next}`;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(ids));
    expect((await api.request('GET', `${C}/calls?before=not-a-cursor`, { cookie: staff })).statusCode).toBe(422);
  });

  it('rejects a bad page size', async () => {
    expect((await api.request('GET', `${C}/calls?limit=5000`, { cookie: staff })).json().error).toBe('invalid_request');
  });
});

describe('task queue', () => {
  it('refuses a write from another origin, even with a valid session', async () => {
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/claim`, { cookie: staff, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/claim`, { cookie: staff, origin: null })).statusCode).toBe(403);
  });

  it('counts open tasks for the menu badge without reading or auditing any', async () => {
    const before = (await api.t.db.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number };
    expect((await api.request('GET', `${C}/tasks/count`, { cookie: staff })).json()).toEqual({ open: 1 });
    const after = (await api.t.db.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('a holder can release a task; an admin can release someone else\'s; staff cannot', async () => {
    const release = (cookie: string) => api.request('POST', `${C}/tasks/${api.taskId}/release`, { cookie });
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/claim`, { cookie: staff })).statusCode).toBe(204);
    expect((await release(staff)).statusCode).toBe(204);
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/claim`, { cookie: admin })).statusCode).toBe(204);
    expect((await release(staff)).statusCode).toBe(409);
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/claim`, { cookie: staff })).statusCode).toBe(409);
    expect((await release(admin)).statusCode).toBe(204);
  });

  it('one person claims, a second gets 409, the holder closes it', async () => {
    const tasks = (await api.request('GET', `${C}/tasks`, { cookie: staff })).json().tasks;
    expect(tasks[0]).toMatchObject({ id: api.taskId, patientName: 'Maria Delgado', details: { medication: 'lisinopril' } });
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/claim`, { cookie: staff })).statusCode).toBe(204);
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/claim`, { cookie: admin })).statusCode).toBe(409);
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/done`, { cookie: staff })).statusCode).toBe(204);
    expect((await api.request('GET', `${C}/tasks?status=done`, { cookie: staff })).json().tasks[0].doneByUserId).toBe(api.users.staff);
  });
});

describe('settings', () => {
  it('refuses a greeting that hides the AI, with the reason', async () => {
    const res = await api.request('PUT', `${C}/settings`, { cookie: admin, body: { ...DEMO_CLINIC, greeting: 'Hi, Maple Street, how can I help?' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().issues[0]).toMatchObject({ path: 'greeting' });
  });

  it('refuses an emergency number that is not on the clinic country\'s list, like a typo', async () => {
    for (const emergencyNumber of ['91', '112', '999']) {
      const res = await api.request('PUT', `${C}/settings`, { cookie: admin, body: { ...DEMO_CLINIC, emergencyNumber } });
      expect(res.statusCode, emergencyNumber).toBe(422);
      expect(res.json().issues[0]).toMatchObject({ path: 'emergencyNumber', message: expect.stringContaining('911') });
    }
    expect((await api.request('PUT', `${C}/settings`, { cookie: admin, body: { ...DEMO_CLINIC, emergencyNumber: '911' } })).statusCode).toBe(200);
  });

  it('refuses a change to the phone numbers, including their order', async () => {
    const res = await api.request('PUT', `${C}/settings`, { cookie: admin, body: { ...DEMO_CLINIC, phoneNumbers: ['+19995550000'] } });
    expect(res.json().issues[0].path).toBe('phoneNumbers');
    // the first number sends the texts, so swapping the order is a change too
    const two = ['+13035550100', '+13035550101'];
    await api.t.db.execute(sql`update clinics set config = jsonb_set(config, '{phoneNumbers}', ${JSON.stringify(two)}::jsonb) where id = ${DEMO_CLINIC.id}`);
    const reordered = await api.request('PUT', `${C}/settings`, { cookie: admin, body: { ...DEMO_CLINIC, phoneNumbers: [...two].reverse() } });
    expect(reordered.json().issues[0].path).toBe('phoneNumbers');
    await api.t.db.execute(sql`update clinics set config = jsonb_set(config, '{phoneNumbers}', ${JSON.stringify(DEMO_CLINIC.phoneNumbers)}::jsonb) where id = ${DEMO_CLINIC.id}`);
  });

  it('saves a valid change and shows it in the audit trail', async () => {
    const holidays = ['2026-11-26'];
    expect((await api.request('PUT', `${C}/settings`, { cookie: admin, body: { ...DEMO_CLINIC, holidays } })).statusCode).toBe(200);
    expect((await api.request('GET', `${C}/settings`, { cookie: staff })).json().holidays).toEqual(holidays);
    const audit = (await api.request('GET', `${C}/audit?limit=100`, { cookie: admin })).json();
    expect(audit.entries[0]).toMatchObject({ action: 'clinic.settings.updated', actor: `user:${api.users.admin}` });
  });
});

describe('openapi', () => {
  it('publishes the document', async () => {
    const res = await api.request('GET', '/api/docs-json');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/api/v1/clinics/{clinicId}/calls');
  });
});
