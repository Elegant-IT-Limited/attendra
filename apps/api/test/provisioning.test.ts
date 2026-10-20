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
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/numbers/${encodeURIComponent('+13035550177')}`, { authorization: auth })).statusCode).toBe(204);
    expect(await clinicForNumber(api.t.db, '+13035550177')).toMatchObject({ id: DEMO_CLINIC.id });
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/numbers/12345`, { authorization: auth })).statusCode).toBe(422);
    expect((await api.request('DELETE', `${P}/numbers/${encodeURIComponent('+13035550177')}`, { authorization: auth })).statusCode).toBe(204);
    expect(await clinicForNumber(api.t.db, '+13035550177')).toBeNull();

    await api.t.db.execute(sql`update calls set ended_at = started_at + interval '95 seconds', channel = 'phone' where id = ${api.callId}`);
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const usage = await api.request('GET', `${P}/clinics/${DEMO_CLINIC.id}/usage?from=${from}&to=${to}`, { authorization: auth });
    expect(usage.json()).toEqual({ calls: 1, seconds: 95 });

    const report = (await api.request('GET', `${P}/clinics/${DEMO_CLINIC.id}/report`, { authorization: auth })).json();
    expect(report.clinic).toMatchObject({ id: DEMO_CLINIC.id, averageVisitValue: 150 });
    expect(report.weeks).toHaveLength(1);
    expect(report.owners).toEqual([{ name: 'Omar Owner', email: 'omar@maple.example' }]);
    expect(JSON.stringify(report)).not.toMatch(/Maria|Delgado|lisinopril/);
  });

  it('keeps the hosting plan, which every member sees with the month\'s phone minutes; none on a self-hosted clinic', async () => {
    const G = `/api/v1/clinics/${DEMO_CLINIC.id}/plan`;
    const viewer = await api.signIn('vic@maple.example', true);
    expect((await api.request('GET', G, { cookie: viewer })).json()).toEqual({ plan: null, minutesUsed: null });

    await api.t.db.execute(sql`update calls set started_at = now() - interval '1 hour', ended_at = now() - interval '1 hour' + interval '125 seconds', channel = 'phone' where id = ${api.callId}`);
    const plan = {
      status: 'active', includedMinutes: 400, periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 29 * 86_400_000).toISOString(),
      trialEndsAt: null, trialDays: 14, endsAt: null, manageUrl: '/account/billing/clinic_maple',
    };
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('GET', G, { cookie: viewer })).json()).toEqual({ plan, minutesUsed: 3 });

    // a trial counts no minutes; a link a browser would run is refused; an unknown clinic is a 404
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: { ...plan, status: 'trial', trialEndsAt: plan.periodEnd } }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('GET', G, { cookie: viewer })).json()).toMatchObject({ plan: { status: 'trial' }, minutesUsed: null });
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: { ...plan, manageUrl: 'javascript:alert(1)' } }, authorization: auth })).statusCode).toBe(422);
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: { ...plan, manageUrl: '//evil.example' } }, authorization: auth })).statusCode).toBe(422);
    expect((await api.request('PUT', `${P}/clinics/clinic_none/plan`, { body: { plan }, authorization: auth })).statusCode).toBe(404);
    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan }, authorization: 'Bearer wrong' })).statusCode).toBe(401);

    expect((await api.request('PUT', `${P}/clinics/${DEMO_CLINIC.id}/plan`, { body: { plan: null }, authorization: auth })).statusCode).toBe(204);
    expect((await api.request('GET', G, { cookie: viewer })).json()).toEqual({ plan: null, minutesUsed: null });
  });
});
