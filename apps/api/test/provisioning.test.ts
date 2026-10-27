import { DEMO_CLINIC } from '@attendra/core';
import { clinicForNumber } from '@attendra/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

const TOKEN = 'p'.repeat(40);
const auth = `Bearer ${TOKEN}`;
const P = '/api/v1/provisioning';
let api: Awaited<ReturnType<typeof startApi>>;

beforeAll(async () => { api = await startApi({ demoMode: false, twoFactor: 'optional', provisioningToken: TOKEN }); });
afterAll(() => api.close());

const account = {
  organization: { name: 'Oak Hill Vets' },
  clinic: { name: 'Oak Hill Vets', timezone: 'America/Chicago', industry: 'vet', phone: '+13125550100' },
  owner: { name: 'Dana Oak', email: 'Dana@OakHill.example', password: 'a-long-password-1' },
  testCallMinutes: 10,
  plan: 'trial',
};

describe('provisioning', () => {
  it('needs the token, and does not exist without one', async () => {
    expect((await api.request('POST', `${P}/accounts`, { body: account })).statusCode).toBe(401);
    expect((await api.request('POST', `${P}/accounts`, { body: account, authorization: 'Bearer wrong' })).statusCode).toBe(401);
    const bare = await startApi({ demoMode: false });
    try {
      expect((await bare.request('POST', `${P}/accounts`, { body: account, authorization: auth })).statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });

  it('checks the token before the request: a malformed one without it is 401 on every route, and 422 with it', async () => {
    const c = DEMO_CLINIC.id;
    // every route that reads a body, a query or a number from the address, each sent malformed
    const malformed: ['GET' | 'POST' | 'PUT' | 'DELETE', string, object | undefined][] = [
      ['POST', `${P}/accounts`, {}],
      ['POST', `${P}/accounts/for-user`, {}],
      ['POST', `${P}/organizations/org_demo/clinics`, {}],
      ['DELETE', `${P}/accounts/unconfirmed`, {}],
      ['POST', `${P}/users/reset-two-factor`, { email: 'not an email' }],
      ['POST', `${P}/email-confirmations`, {}],
      ['PUT', `${P}/clinics/${c}/test-call-limit`, { seconds: -1 }],
      ['PUT', `${P}/clinics/${c}/texting`, {}],
      ['PUT', `${P}/clinics/${c}/answering`, {}],
      ['PUT', `${P}/clinics/${c}/plan`, {}],
      ['PUT', `${P}/clinics/${c}/closed`, {}],
      ['PUT', `${P}/clinics/${c}/voice-engine`, { engine: 'grok' }],
      ['PUT', `${P}/clinics/${c}/numbers/12345`, undefined],
      ['GET', `${P}/clinics/${c}/usage?from=yesterday`, undefined],
      ['POST', `${P}/clinics/${c}/calls-check`, {}],
      ['GET', `${P}/clinics/${c}/report?weeks=99`, undefined],
    ];
    for (const [method, path, body] of malformed) {
      expect((await api.request(method, path, { body })).statusCode, `${method} ${path} without the token`).toBe(401);
      expect((await api.request(method, path, { body, authorization: 'Bearer wrong' })).statusCode, `${method} ${path} with a wrong token`).toBe(401);
      expect((await api.request(method, path, { body, authorization: auth })).statusCode, `${method} ${path} with the token`).toBe(422);
    }
    // and the routes with nothing to validate
    for (const [method, path] of [['DELETE', `${P}/clinics/clinic_none`], ['DELETE', `${P}/numbers/+13035550199`]] as const) {
      expect((await api.request(method, path)).statusCode, `${method} ${path}`).toBe(401);
    }
  });

  it('opens an account whose owner signs in only after the email is confirmed, and without two-step sign-in here', async () => {
    const res = await api.request('POST', `${P}/accounts`, { body: account, authorization: auth, origin: null });
    expect(res.statusCode).toBe(201);
    const { organizationId, clinicId, userId } = res.json();
    expect([organizationId, clinicId, userId].every(Boolean)).toBe(true);
    const signIn = () => api.request('POST', '/api/auth/sign-in/email', { body: { email: 'dana@oakhill.example', password: account.owner.password } });
    expect((await signIn()).statusCode).toBe(403);
    expect((await api.request('POST', `${P}/email-confirmations`, { body: { email: 'dana@oakhill.example' }, authorization: auth })).statusCode).toBe(204);
    const ok = await signIn();
    expect(ok.statusCode).toBe(200);
    const cookie = ([] as string[]).concat(ok.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
    const me = (await api.request('GET', '/api/v1/me', { cookie })).json();
    expect(me.twoFactorRequired).toBe(false);
    expect(me.clinics).toEqual([expect.objectContaining({ id: clinicId, name: 'Oak Hill Vets', role: 'owner' })]);
    const settings = await api.request('GET', `/api/v1/clinics/${clinicId}/settings`, { cookie });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ industry: 'vet', afterHours: 'requests', phoneNumbers: ['+13125550100'] });
    expect((await api.request('GET', `/api/v1/clinics/${clinicId}/test-calls/allowance`, { cookie })).json()).toEqual({ limitSeconds: 600, usedSeconds: 0 });
    expect(await clinicForNumber(api.t.db, '+13125550100')).toBeNull();

    // the same email again
    expect((await api.request('POST', `${P}/accounts`, { body: account, authorization: auth })).json()).toEqual({ error: 'email_taken', confirmed: true });
    // an unknown time zone
    const bad = await api.request('POST', `${P}/accounts`, { body: { ...account, owner: { ...account.owner, email: 'x@oakhill.example' }, clinic: { ...account.clinic, timezone: 'Mars/Base' } }, authorization: auth });
    expect(bad.statusCode).toBe(422);
  });

  it('adds a second location with the first one\'s assistant, seen by the owner at once', async () => {
    const opened = (await api.request('POST', `${P}/accounts`, { body: { ...account, owner: { ...account.owner, email: 'two@oakhill.example' } }, authorization: auth })).json();
    const location = { clinic: { name: 'Oak Hill South', timezone: 'America/Chicago', industry: 'vet', phone: '+13125550111' }, testCallMinutes: 5 };
    expect((await api.request('POST', `${P}/organizations/org_none/clinics`, { body: location, authorization: auth })).statusCode).toBe(404);
    expect((await api.request('POST', `${P}/organizations/${opened.organizationId}/clinics`, { body: location })).statusCode).toBe(401);
    const res = await api.request('POST', `${P}/organizations/${opened.organizationId}/clinics`, { body: location, authorization: auth });
    expect(res.statusCode).toBe(201);
    const { clinicId } = res.json();
    expect(clinicId).not.toBe(opened.clinicId);
    await api.request('POST', `${P}/email-confirmations`, { body: { email: 'two@oakhill.example' }, authorization: auth });
    const ok = await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'two@oakhill.example', password: account.owner.password } });
    const cookie = ([] as string[]).concat(ok.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
    const me = (await api.request('GET', '/api/v1/me', { cookie })).json();
    expect(me.clinics.map((c: { id: string }) => c.id).sort()).toEqual([opened.clinicId, clinicId].sort());
    const settings = (await api.request('GET', `/api/v1/clinics/${clinicId}/settings`, { cookie })).json();
    expect(settings).toMatchObject({ name: 'Oak Hill South', industry: 'vet' });
    expect(settings.greeting).toContain('Oak Hill South');
    expect((await api.t.db.execute(sql`select entity_id from audit_logs where action = 'clinic.created' and clinic_id = ${opened.clinicId}`)).rows).toEqual([{ entity_id: clinicId }]);
  });

  it('opens a second, separate clinic for an owner on the same login; never for staff or an unconfirmed login', async () => {
    const opened = (await api.request('POST', `${P}/accounts`, { body: { ...account, owner: { ...account.owner, email: 'three@oakhill.example' } }, authorization: auth })).json();
    const second = { organization: { name: 'Lakeside Pet Care' }, clinic: { name: 'Lakeside Pet Care', timezone: 'America/Denver', industry: 'vet', phone: '+13035550190' }, testCallMinutes: 5, plan: 'trial' };
    const forUser = (userId: string, o: { authorization?: string } = { authorization: auth }) => api.request('POST', `${P}/accounts/for-user`, { body: { ...second, userId }, ...o });
    expect((await forUser(opened.userId, {})).statusCode).toBe(401);
    expect((await forUser('user_none')).statusCode).toBe(404);
    // a login whose email was never confirmed opens nothing more
    expect([(await forUser(opened.userId)).statusCode, (await forUser(opened.userId)).json()]).toEqual([409, { error: 'not_confirmed' }]);
    await api.request('POST', `${P}/email-confirmations`, { body: { email: 'three@oakhill.example' }, authorization: auth });

    // staff on someone else's team: a work email belongs to the clinic
    const staffOnly = await forUser(api.users.staff);
    expect([staffOnly.statusCode, staffOnly.json()]).toEqual([403, { error: 'not_an_owner' }]);

    const res = await forUser(opened.userId);
    expect(res.statusCode).toBe(201);
    const made = res.json();
    expect(made).toMatchObject({ userId: opened.userId });
    expect(made.organizationId).not.toBe(opened.organizationId);
    expect(made.clinicId).not.toBe(opened.clinicId);

    // the switcher lists both clinics, owner of each; the new one starts empty, with its own name and greeting
    const ok = await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'three@oakhill.example', password: account.owner.password } });
    const cookie = ([] as string[]).concat(ok.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
    const me = (await api.request('GET', '/api/v1/me', { cookie })).json();
    expect(me.clinics.map((c: { id: string; role: string }) => [c.id, c.role]).sort()).toEqual([[opened.clinicId, 'owner'], [made.clinicId, 'owner']].sort());
    const settings = (await api.request('GET', `/api/v1/clinics/${made.clinicId}/settings`, { cookie })).json();
    expect(settings).toMatchObject({ name: 'Lakeside Pet Care', timezone: 'America/Denver', phoneNumbers: ['+13035550190'] });
    expect(settings.greeting).not.toContain('Oak Hill');
    expect((await api.request('GET', `/api/v1/clinics/${made.clinicId}/test-calls/allowance`, { cookie })).json()).toEqual({ limitSeconds: 300, usedSeconds: 0 });
    expect((await api.t.db.execute(sql`select actor, entity_id from audit_logs where action = 'organization.created.by_owner' and clinic_id = ${made.clinicId}`)).rows)
      .toEqual([{ actor: `user:${opened.userId}`, entity_id: made.organizationId }]);
    // the first business is untouched: still one clinic in its organization
    expect((await api.t.db.execute(sql`select id from clinics where org_id = ${opened.organizationId}`)).rows).toEqual([{ id: opened.clinicId }]);
  });

  it('sets which voice engine answers a clinic, which Settings cannot change', async () => {
    const S = `/api/v1/clinics/${DEMO_CLINIC.id}/settings`;
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/voice-engine`, { body: { engine: 'gpt-realtime' }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/voice-engine`, { body: { engine: 'grok' }, authorization: auth })).statusCode).toBe(422);
    expect((await api.request('PUT', `${P}/clinics/clinic_none/voice-engine`, { body: { engine: null }, authorization: auth })).statusCode).toBe(404);
    const cookie = await api.signIn('olga@maple.example', true);
    const settings = (await api.request('GET', S, { cookie })).json();
    expect(settings.voiceEngine).toBe('gpt-realtime');
    // a save from Settings that drops or changes it keeps the operator's choice
    expect((await api.request('PUT', S, { cookie, body: { ...settings, voiceEngine: 'gpt-live' } })).json().voiceEngine).toBe('gpt-realtime');
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/voice-engine`, { body: { engine: null }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('GET', S, { cookie })).json().voiceEngine).toBeUndefined();
  });

  it('sets test-call time, points numbers, and reads minutes and the weekly report', async () => {
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/test-call-limit`, { body: { seconds: 300 }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('PUT', `${P}/clinics/clinic_none/test-call-limit`, { body: { seconds: 300 }, authorization: auth })).statusCode).toBe(404);
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/test-call-limit`, { body: { seconds: null }, authorization: auth })).statusCode).toBe(204);

    // texting during calls, switched by the hosting layer when the texting registration is approved
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/texting`, { body: { enabled: true }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('GET', `/api/v1/clinics/${DEMO_CLINIC.id}/settings/meta`, { cookie: await api.signIn('omar@maple.example', true) })).json()).toMatchObject({ updatedBy: { name: 'Attendra' } });
    expect((await api.request('PUT', `${P}/clinics/clinic_none/texting`, { body: { enabled: true }, authorization: auth })).statusCode).toBe(404);
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/texting`, { body: { enabled: false }, authorization: auth })).statusCode).toBe(204);
    // the assistant paused by the hosting layer (the plan), and answering again; Settings never changes it
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/answering`, { body: { paused: true }, authorization: auth })).statusCode).toBe(204);
    const pausedNow = async () => ((await api.t.db.execute(sql`select config->'answeringPaused' as p from clinics where id = ${DEMO_CLINIC.id}`)).rows[0] as { p: unknown }).p;
    expect(await pausedNow()).toBe(true);
    expect((await api.request('PUT', `${P}/clinics/clinic_none/answering`, { body: { paused: true }, authorization: auth })).statusCode).toBe(404);
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/answering`, { body: { paused: false }, authorization: auth })).statusCode).toBe(204);
    expect(await pausedNow()).toBe(false);
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/numbers/${encodeURIComponent('+13035550177')}`, { authorization: auth })).statusCode).toBe(204);
    expect(await clinicForNumber(api.t.db, '+13035550177')).toMatchObject({ id: DEMO_CLINIC.id });
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/numbers/12345`, { authorization: auth })).statusCode).toBe(422);
    expect((await api.request('DELETE', `${P}/numbers/${encodeURIComponent('+13035550177')}`, { authorization: auth })).statusCode).toBe(204);
    expect(await clinicForNumber(api.t.db, '+13035550177')).toBeNull();
    // the clinic's audit log shows the number it got and the one it gave back
    expect((await api.t.db.execute(sql`select action, entity_id from audit_logs where clinic_id = ${DEMO_CLINIC.id} and action like 'number.%' order by id`)).rows)
      .toEqual([{ action: 'number.assigned', entity_id: '+13035550177' }, { action: 'number.released', entity_id: '+13035550177' }]);

    await api.t.db.execute(sql`update calls set ended_at = started_at + interval '95 seconds', channel = 'phone' where id = ${api.callId}`);
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const usage = await api.request('GET', `${P}/clinics/${DEMO_CLINIC.id}/usage?from=${from}&to=${to}`, { authorization: auth });
    expect(usage.json()).toEqual({ calls: 1, seconds: 95, texts: 0 });

    // the forwarding check and the quiet-line alert: calls since a moment, and one from a number, by its hash
    const caller = '+13035550147';
    const since = new Date(Date.now() - 3_600_000).toISOString();
    await api.t.db.execute(sql`update calls set started_at = now() - interval '10 minutes', ended_at = now() - interval '10 minutes' + interval '95 seconds' where id = ${api.callId}`);
    const check = (body: object) => api.request('POST', `${P}/clinics/${DEMO_CLINIC.id}/calls-check`, { body, authorization: auth });
    expect((await check({ since, from: caller })).json()).toMatchObject({ calls: 1, heard: true });
    expect((await check({ since, from: '+13035550122' })).json()).toMatchObject({ calls: 1, heard: false });
    const quiet = (await check({ since: new Date().toISOString() })).json();
    expect(quiet).toMatchObject({ calls: 0, lastCallAt: null, heard: null });
    expect(typeof quiet.openMinutes).toBe('number');
    expect((await check({ since, from: '303 555 0147' })).statusCode).toBe(422);
    expect((await api.request('POST', `${P}/clinics/clinic_none/calls-check`, { body: { since }, authorization: auth })).statusCode).toBe(404);
    expect((await api.request('POST', `${P}/clinics/${DEMO_CLINIC.id}/calls-check`, { body: { since } })).statusCode).toBe(401);

    const report = (await api.request('GET', `${P}/clinics/${DEMO_CLINIC.id}/report`, { authorization: auth })).json();
    expect(report.clinic).toMatchObject({ id: DEMO_CLINIC.id, averageVisitValue: 150 });
    expect(report.weeks).toHaveLength(1);
    expect(report.owners).toEqual([{ name: 'Omar Owner', email: 'omar@maple.example' }]);
    expect(JSON.stringify(report)).not.toMatch(/Maria|Delgado|lisinopril/);
  });

  it('keeps the hosting plan, which every member sees with the month\'s phone minutes; none on a self-hosted clinic', async () => {
    const G = `/api/v1/clinics/${DEMO_CLINIC.id}/plan`;
    const viewer = await api.signIn('vic@maple.example', true);
    expect((await api.request('GET', G, { cookie: viewer })).json()).toEqual({ plan: null, minutesUsed: null, textsUsed: null });

    await api.t.db.execute(sql`update calls set started_at = now() - interval '1 hour', ended_at = now() - interval '1 hour' + interval '125 seconds', channel = 'phone' where id = ${api.callId}`);
    const plan = {
      status: 'active', includedMinutes: 400, periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 29 * 86_400_000).toISOString(),
      trialEndsAt: null, trialDays: 14, endsAt: null, manageUrl: '/account/billing/clinic_maple',
    };
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('GET', G, { cookie: viewer })).json()).toEqual({ plan, minutesUsed: 3, textsUsed: 0 });

    // a trial counts no minutes; a link a browser would run is refused; an unknown clinic is a 404
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: { ...plan, status: 'trial', trialEndsAt: plan.periodEnd } }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('GET', G, { cookie: viewer })).json()).toMatchObject({ plan: { status: 'trial' }, minutesUsed: null });
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: { ...plan, manageUrl: 'javascript:alert(1)' } }, authorization: auth })).statusCode).toBe(422);
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: { ...plan, manageUrl: '//evil.example' } }, authorization: auth })).statusCode).toBe(422);
    expect((await api.request('PUT', `${P}/clinics/clinic_none/plan`, { body: { plan }, authorization: auth })).statusCode).toBe(404);
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan }, authorization: 'Bearer wrong' })).statusCode).toBe(401);

    // the owner's steps to real calls, for the card on Today; a link a browser would run is refused there too
    const goLive = { setupUrl: '/account/setup/clinic_maple', steps: [
      { title: 'Choose your plan', status: 'Active', state: 'done', href: '/account/billing/clinic_maple', optional: false },
      { title: 'Get your assistant\'s number', status: 'To do', state: 'todo', href: '/account/numbers/clinic_maple', optional: false },
    ] };
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: { ...plan, goLive } }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('GET', G, { cookie: viewer })).json()).toMatchObject({ plan: { goLive } });
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: { ...plan, goLive: { ...goLive, setupUrl: 'javascript:alert(1)' } } }, authorization: auth })).statusCode).toBe(422);
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: { ...plan, goLive: { setupUrl: null, steps: [{ ...goLive.steps[0], href: '//evil.example' }] } } }, authorization: auth })).statusCode).toBe(422);

    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: null }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('GET', G, { cookie: viewer })).json()).toEqual({ plan: null, minutesUsed: null, textsUsed: null });
  });

  it('gives the hosting layer a location at a glance, and renames one: the dashboard and the business on /me follow (2026-11)', async () => {
    const opened = (await api.request('POST', `${P}/accounts`, { body: { ...account, organization: { name: 'Cedar Row Vets' }, clinic: { ...account.clinic, name: 'Cedar Row Vets', phone: '+13125550107' }, owner: { name: 'Rowan Cedar', email: 'rowan@cedarrow.example', password: 'a-long-password-1' } }, authorization: auth, origin: null })).json();
    const location = (await api.request('POST', `${P}/organizations/${opened.organizationId}/clinics`, { body: { clinic: { name: 'Cedar Row Downtown', timezone: 'America/Chicago', industry: 'vet', phone: '+13125550108' } }, authorization: auth })).json();
    // at a glance: counts only, the number, the city from the address
    expect((await api.request('GET', `${P}/clinics/${location.clinicId}/overview`)).statusCode).toBe(401);
    expect((await api.request('GET', `${P}/clinics/clinic_none/overview`, { authorization: auth })).statusCode).toBe(404);
    const glance = await api.request('GET', `${P}/clinics/${location.clinicId}/overview`, { authorization: auth });
    expect(glance.statusCode).toBe(200);
    expect(glance.json()).toEqual({ name: 'Cedar Row Downtown', phoneNumber: '+13125550108', city: null, callsToday: 0, openRequests: 0 });
    // the rename: under the field when it is too short, 204 and everywhere otherwise
    const short = await api.request('PUT', `${P}/clinics/${location.clinicId}/name`, { body: { name: 'C' }, authorization: auth });
    expect(short.statusCode).toBe(422);
    expect(short.json().issues[0]).toMatchObject({ path: 'name' });
    expect((await api.request('PUT', `${P}/clinics/${location.clinicId}/name`, { body: { name: 'Downtown' }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('PUT', `${P}/clinics/clinic_none/name`, { body: { name: 'Downtown' }, authorization: auth })).statusCode).toBe(404);
    expect((await api.request('GET', `${P}/clinics/${location.clinicId}/overview`, { authorization: auth })).json().name).toBe('Downtown');
    expect((await api.request('POST', `${P}/email-confirmations`, { body: { email: 'rowan@cedarrow.example' }, authorization: auth })).statusCode).toBe(204);
    const ok = await api.request('POST', '/api/auth/sign-in/email', { body: { email: 'rowan@cedarrow.example', password: 'a-long-password-1' } });
    const cookie = ([] as string[]).concat(ok.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
    const me = (await api.request('GET', '/api/v1/me', { cookie })).json();
    expect(me.clinics).toEqual([
      expect.objectContaining({ name: 'Cedar Row Vets', organizationId: opened.organizationId, organizationName: 'Cedar Row Vets' }),
      expect.objectContaining({ id: location.clinicId, name: 'Downtown', organizationId: opened.organizationId, organizationName: 'Cedar Row Vets' }),
    ]);
    expect((await api.request('GET', `/api/v1/clinics/${location.clinicId}/settings`, { cookie })).json().name).toBe('Downtown');
    const audit = (await api.t.db.execute(sql`select count(*)::int as n from audit_logs where clinic_id = ${location.clinicId} and action = 'clinic.renamed'`)).rows;
    expect(audit).toEqual([{ n: 1 }]);
  });
});
