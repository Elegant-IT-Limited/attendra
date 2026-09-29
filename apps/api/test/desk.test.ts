import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { PostgresTaskQueue, createPhiCipher } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, PASSWORD, startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const O = `/api/v1/clinics/${OTHER.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'admin' | 'staff' | 'viewer', string>;
let callback: string;

const audit = async (action: string) =>
  ((await api.t.db.execute(sql`select actor, entity_id from audit_logs where action = ${action} order by id`)).rows as { actor: string; entity_id: string }[]);
const count = async () => ((await api.t.db.execute(sql`select count(*)::int as n from audit_logs`)).rows[0] as { n: number }).n;

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  as = {
    owner: await api.signIn('omar@maple.example', true),
    admin: await api.signIn('olga@maple.example', true),
    staff: await api.signIn('ana@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true),
  };
  ({ id: callback } = await new PostgresTaskQueue(api.t.db, createPhiCipher(TEST_DATA_KEY)).create(DEMO_CLINIC.id, {
    type: 'callback', callId: api.callId, patientId: null, idempotencyKey: 'desk-callback', details: { reason: 'billing question', callback_number: '+13035550199' },
  }));
});
afterAll(() => api.close());

describe('requests', () => {
  const list = async (q = '', cookie = as.staff) => (await api.request('GET', `${C}/tasks${q}`, { cookie })).json().tasks as { id: string; type: string; assigneeName: string | null; notes: { author: string; body: string }[]; outcome: string | null; patientId: string | null }[];

  it('filters by type and by who has them, reading and auditing only what is shown', async () => {
    expect((await list('?type=refill')).map((t) => t.id)).toEqual([api.taskId]);
    expect((await list('?type=callback')).map((t) => t.id)).toEqual([callback]);
    const before = (await audit('task.viewed')).length;
    await list('?type=voicemail');
    expect((await audit('task.viewed')).length).toBe(before);
    expect((await list('?assignee=me')).map((t) => t.id)).toEqual([]);
    expect((await list('?assignee=unassigned')).map((t) => t.id).sort()).toEqual([api.taskId, callback].sort());
    expect((await list())[0]!.patientId).toBe(api.patientIds.maria);
    expect((await api.request('GET', `${C}/tasks?assignee=bob`, { cookie: as.staff })).json().error).toBe('invalid_request');
  });

  it('adds an encrypted internal note under the author\'s name, audited', async () => {
    const res = await api.request('POST', `${C}/tasks/${api.taskId}/notes`, { cookie: as.staff, body: { body: 'Pharmacy closed until 9, calling back then.' } });
    expect(res.statusCode).toBe(204);
    expect((await list('?type=refill'))[0]!.notes).toEqual([expect.objectContaining({ author: 'Ana Front', body: 'Pharmacy closed until 9, calling back then.' })]);
    expect(JSON.stringify((await api.t.db.execute(sql`select * from task_notes`)).rows)).not.toContain('Pharmacy');
    expect(await audit('task.note.added')).toEqual([{ actor: `user:${api.users.staff}`, entity_id: api.taskId }]);
  });

  it('refuses an empty note, a viewer, another clinic and another origin', async () => {
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/notes`, { cookie: as.staff, body: { body: '  ' } })).json().error).toBe('invalid_request');
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/notes`, { cookie: as.viewer, body: { body: 'x' } })).statusCode).toBe(403);
    expect((await api.request('POST', `${O}/tasks/${api.taskId}/notes`, { cookie: as.owner, body: { body: 'x' } })).statusCode).toBe(404);
    expect((await api.request('POST', `${C}/tasks/${api.taskId}/notes`, { cookie: as.staff, body: { body: 'x' }, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/tasks/00000000-0000-4000-8000-000000000000/notes`, { cookie: as.staff, body: { body: 'x' } })).statusCode).toBe(404);
  });

  it('lets owners and managers assign a request to someone on the front desk, audited; not staff, not to a viewer', async () => {
    expect((await api.request('POST', `${C}/tasks/${callback}/assign`, { cookie: as.staff, body: { userId: api.users.staff } })).statusCode).toBe(403);
    expect((await api.request('POST', `${C}/tasks/${callback}/assign`, { cookie: as.admin, body: { userId: api.users.viewer } })).statusCode).toBe(422);
    expect((await api.request('POST', `${C}/tasks/${callback}/assign`, { cookie: as.admin, body: { userId: api.users.outsider } })).statusCode).toBe(422);
    expect((await api.request('POST', `${C}/tasks/${callback}/assign`, { cookie: as.admin, body: { userId: api.users.staff } })).statusCode).toBe(204);
    expect((await list('?assignee=me'))).toEqual([expect.objectContaining({ id: callback, assigneeName: 'Ana Front' })]);
    expect(await audit('task.assigned')).toEqual([{ actor: `user:${api.users.admin}`, entity_id: callback }]);
    expect((await api.request('POST', `${O}/tasks/${callback}/assign`, { cookie: as.owner, body: { userId: api.users.staff } })).statusCode).toBe(404);
  });

  it('closes with an outcome, and refuses one that is not on the list', async () => {
    expect((await api.request('POST', `${C}/tasks/${callback}/done`, { cookie: as.staff, body: { outcome: 'emailed them' } })).json().error).toBe('invalid_request');
    expect((await api.request('POST', `${C}/tasks/${callback}/done`, { cookie: as.staff, body: { outcome: 'left_message' } })).statusCode).toBe(204);
    expect((await list('?status=done&type=callback'))[0]!.outcome).toBe('left_message');
  });
});

describe('calls', () => {
  beforeAll(async () => {
    await api.t.db.execute(sql`update calls set patient_id = ${api.patientIds.maria!}, started_at = ${zonedInstant('2026-09-28', '14:00', DEMO_CLINIC.timezone).toISOString()} where id = ${api.callId}`);
    await api.t.db.execute(sql`insert into calls (clinic_id, openai_session_id, started_at, outcome, emergency_flag, channel)
      values (${DEMO_CLINIC.id}, 'live_desk_2', ${zonedInstant('2026-09-20', '09:00', DEMO_CLINIC.timezone).toISOString()}, 'emergency', true, 'phone'),
             (${DEMO_CLINIC.id}, 'live_desk_3', ${zonedInstant('2026-09-29', '09:00', DEMO_CLINIC.timezone).toISOString()}, 'booked', false, 'web')`);
  });
  const ids = async (q: string, cookie = as.staff) => (await api.request('GET', `${C}/calls${q}`, { cookie })).json().calls.map((c: { outcome: string }) => c.outcome);

  it('filters by date range in clinic time, outcome, channel and emergency', async () => {
    expect(await ids('?from=2026-09-28&to=2026-09-28')).toEqual(['task_created']);
    expect(await ids('?from=2026-09-21')).toEqual(['booked', 'task_created']);
    expect(await ids('?outcome=emergency')).toEqual(['emergency']);
    expect(await ids('?channel=web')).toEqual(['booked']);
    expect(await ids('?emergency=true')).toEqual(['emergency']);
    expect((await api.request('GET', `${C}/calls?outcome=partied`, { cookie: as.staff })).json().error).toBe('invalid_request');
  });

  it('names the verified caller for staff, audited once per five minutes; a viewer gets no names and no row', async () => {
    const staffView = (await api.request('GET', `${C}/calls`, { cookie: as.staff })).json().calls;
    await api.request('GET', `${C}/calls`, { cookie: as.staff });
    expect(staffView.find((c: { id: string }) => c.id === api.callId).patientName).toBe('Maria Delgado');
    // the filter test above listed calls too, a moment ago: one row covers all of it
    expect(await audit('calls.listed')).toEqual([{ actor: `user:${api.users.staff}`, entity_id: null }]);
    const n = await count();
    const viewerView = await api.request('GET', `${C}/calls`, { cookie: as.viewer });
    expect(viewerView.body).not.toContain('Maria');
    expect(viewerView.json().calls.every((c: { patientName: null }) => c.patientName === null)).toBe(true);
    expect(await count()).toBe(n);
  });

  it('searches by patient name as a POST, audited with the count, and not for a viewer', async () => {
    const res = await api.request('POST', `${C}/calls/search`, { cookie: as.staff, body: { query: 'delg' } });
    expect(res.json().calls.map((c: { id: string; patientName: string }) => [c.id, c.patientName])).toEqual([[api.callId, 'Maria Delgado']]);
    expect((await api.request('POST', `${C}/calls/search`, { cookie: as.staff, body: { query: 'nobody here' } })).json().calls).toEqual([]);
    expect((await audit('calls.searched')).map((r) => r.entity_id)).toEqual(['matches:1', 'matches:0']);
    expect((await api.request('POST', `${C}/calls/search`, { cookie: as.viewer, body: { query: 'delg' } })).statusCode).toBe(403);
    expect((await api.request('POST', `${O}/calls/search`, { cookie: as.owner, body: { query: 'delg' } })).statusCode).toBe(404);
    expect((await api.request('POST', `${C}/calls/search`, { cookie: as.staff, body: { query: 'd' } })).json().error).toBe('invalid_request');
  });
});

describe('the team', () => {
  const M = `${C}/members`;
  const members = async (cookie = as.admin) => (await api.request('GET', M, { cookie })).json().members as { userId: string; email: string; role: string; you: boolean; twoFactorEnabled: boolean; lastSignInAt: string | null }[];

  it('is for owners and managers only, and another clinic is 404', async () => {
    expect((await api.request('GET', M, { cookie: as.staff })).statusCode).toBe(403);
    expect((await api.request('GET', M, { cookie: as.viewer })).statusCode).toBe(403);
    expect((await api.request('GET', `${O}/members`, { cookie: as.owner })).statusCode).toBe(404);
    const list = await members(as.owner);
    expect(list.map((m) => m.email).sort()).toEqual(['ana@maple.example', 'olga@maple.example', 'omar@maple.example', 'vic@maple.example']);
    expect(list.find((m) => m.email === 'omar@maple.example')).toMatchObject({ role: 'owner', you: true, twoFactorEnabled: true, lastSignInAt: expect.any(String) });
  });

  it('adds someone with a temporary password shown once, which signs in; audited', async () => {
    const res = await api.request('POST', M, { cookie: as.admin, body: { name: 'Nia New', email: 'Nia@Maple.example', role: 'staff' } });
    expect(res.statusCode).toBe(200);
    const { userId, temporaryPassword } = res.json();
    expect(temporaryPassword).toMatch(/^[\w-]{16}$/);
    expect((await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'nia@maple.example', password: temporaryPassword } })).statusCode).toBe(200);
    expect(await audit('member.added')).toEqual([{ actor: `user:${api.users.admin}`, entity_id: userId }]);
    expect((await api.request('POST', M, { cookie: as.admin, body: { name: 'Nia Again', email: 'nia@maple.example', role: 'staff' } })).statusCode).toBe(409);
  });

  it('adds someone who already has an account elsewhere without a new password', async () => {
    const res = await api.request('POST', M, { cookie: as.owner, body: { name: 'Otto Other', email: 'otto@other.example', role: 'viewer' } });
    expect(res.json()).toEqual({ userId: api.users.outsider, temporaryPassword: null });
    expect((await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'otto@other.example', password: PASSWORD } })).statusCode).toBe(200);
  });

  it('keeps managers away from owners, and nobody changes or removes themselves', async () => {
    expect((await api.request('POST', M, { cookie: as.admin, body: { name: 'Big Boss', email: 'boss@maple.example', role: 'owner' } })).statusCode).toBe(403);
    expect((await api.request('PATCH', `${M}/${api.users.owner}`, { cookie: as.admin, body: { role: 'staff' } })).statusCode).toBe(403);
    expect((await api.request('PATCH', `${M}/${api.users.staff}`, { cookie: as.admin, body: { role: 'owner' } })).statusCode).toBe(403);
    expect((await api.request('DELETE', `${M}/${api.users.owner}`, { cookie: as.admin })).statusCode).toBe(403);
    expect((await api.request('PATCH', `${M}/${api.users.admin}`, { cookie: as.admin, body: { role: 'staff' } })).statusCode).toBe(403);
    expect((await api.request('DELETE', `${M}/${api.users.admin}`, { cookie: as.admin })).statusCode).toBe(403);
  });

  it('never leaves an organization without an owner', async () => {
    expect((await api.request('PATCH', `${M}/${api.users.admin}`, { cookie: as.owner, body: { role: 'owner' } })).statusCode).toBe(204);
    expect((await api.request('PATCH', `${M}/${api.users.admin}`, { cookie: as.owner, body: { role: 'admin' } })).statusCode).toBe(204);
    // the owner cannot demote themselves at all, and with one owner nobody else can either
    expect((await api.request('PATCH', `${M}/${api.users.owner}`, { cookie: as.owner, body: { role: 'admin' } })).statusCode).toBe(403);
    expect((await members()).filter((m) => m.role === 'owner')).toHaveLength(1);
  });

  it('changes a role, audited, and the new role applies at once', async () => {
    expect((await api.request('PATCH', `${M}/${api.users.viewer}`, { cookie: as.admin, body: { role: 'staff' } })).statusCode).toBe(204);
    expect((await api.request('GET', `${C}/tasks`, { cookie: as.viewer })).statusCode).toBe(200);
    expect((await audit('member.role.changed')).at(-1)).toEqual({ actor: `user:${api.users.admin}`, entity_id: api.users.viewer });
    expect((await api.request('PATCH', `${M}/${api.users.viewer}`, { cookie: as.admin, body: { role: 'wizard' } })).json().error).toBe('invalid_request');
    expect((await api.request('PATCH', `${M}/nobody`, { cookie: as.admin, body: { role: 'staff' } })).statusCode).toBe(404);
  });

  it('removes someone, signs them out, and audits it', async () => {
    expect((await api.request('DELETE', `${M}/${api.users.viewer}`, { cookie: as.admin, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await api.request('DELETE', `${M}/${api.users.viewer}`, { cookie: as.admin })).statusCode).toBe(204);
    expect((await api.request('GET', '/api/v1/me', { cookie: as.viewer })).statusCode).toBe(401);
    expect((await members()).map((m) => m.email)).not.toContain('vic@maple.example');
    expect((await audit('member.removed')).at(-1)).toEqual({ actor: `user:${api.users.admin}`, entity_id: api.users.viewer });
  });
});
