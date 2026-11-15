// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, DEMO_CLINIC } from '@attendra/core';
import { schema, withClinic } from '@attendra/db';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// A demo clinic's routes for the hosting layer's back office (2026-11-16): the switch, the baseline and a reset now,
// behind the provisioning token, audited with who asked. Made-up details only.
const TOKEN = 'p'.repeat(40);
const auth = `Bearer ${TOKEN}`;
const P = '/api/v1/provisioning';
const C = DEMO_CLINIC.id;
let api: Awaited<ReturnType<typeof startApi>>;
const actor = 'operator@example.com';

beforeAll(async () => { api = await startApi({ demoMode: false, twoFactor: 'optional', provisioningToken: TOKEN }); });
afterAll(() => api.close());

const configOf = async () => {
  const [row] = await api.t.db.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, C));
  return ClinicConfig.parse(row!.config);
};

describe('the demo clinic routes', () => {
  it('need the provisioning token', async () => {
    expect((await api.request('GET', `${P}/clinics/${C}/demo`)).statusCode).toBe(401);
    expect((await api.request('PUT', `${P}/clinics/${C}/demo`, { body: { enabled: true, actor } })).statusCode).toBe(401);
    expect((await api.request('POST', `${P}/clinics/${C}/demo/baseline`, { body: { actor } })).statusCode).toBe(401);
    expect((await api.request('POST', `${P}/clinics/${C}/demo/reset`, { body: { actor } })).statusCode).toBe(401);
  });

  it('a clinic is off by default; a baseline or a reset is refused until it is on', async () => {
    const res = await api.request('GET', `${P}/clinics/${C}/demo`, { authorization: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, baselineAt: null, lastResetAt: null });
    expect((await configOf()).demoClinic).toBeUndefined();
    expect((await api.request('POST', `${P}/clinics/${C}/demo/baseline`, { authorization: auth, body: { actor } })).json()).toEqual({ error: 'not_demo' });
    expect((await api.request('POST', `${P}/clinics/${C}/demo/reset`, { authorization: auth, body: { actor } })).statusCode).toBe(409);
    expect((await api.request('GET', `${P}/clinics/clinic_missing/demo`, { authorization: auth })).statusCode).toBe(404);
    expect((await api.request('PUT', `${P}/clinics/clinic_missing/demo`, { authorization: auth, body: { enabled: true, actor } })).statusCode).toBe(404);
    expect((await api.request('PUT', `${P}/clinics/${C}/demo`, { authorization: auth, body: { enabled: true, actor: 'not an email' } })).statusCode).toBe(422);
  });

  it('turned on: audited with who asked; a Settings save keeps it; then a baseline and a reset', async () => {
    expect((await api.request('PUT', `${P}/clinics/${C}/demo`, { authorization: auth, body: { enabled: true, actor } })).statusCode).toBe(204);
    expect((await configOf()).demoClinic).toEqual({ enabled: true, baselineAt: null });
    const audit = await withClinic(api.t.db, C, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.clinicId, C), like(schema.auditLogs.action, 'clinic.demo.%'))));
    expect(audit.map((a) => [a.action, a.actor])).toEqual([['clinic.demo.on', `backoffice:${actor}`]]);

    // the owner saves Settings with the switch off in the body: the hosting layer's value stays
    const cookie = await api.signIn('omar@maple.example', true);
    const read = await api.request('GET', `/api/v1/clinics/${C}/settings`, { cookie });
    const saved = await api.request('PUT', `/api/v1/clinics/${C}/settings`, { cookie, body: { ...(read.json() as object), demoClinic: { enabled: false, baselineAt: null } }, headers: { 'if-match': read.headers.etag as string } });
    expect(saved.statusCode).toBe(200);
    expect((await configOf()).demoClinic?.enabled).toBe(true);

    const set = await api.request('POST', `${P}/clinics/${C}/demo/baseline`, { authorization: auth, body: { actor } });
    expect(set.statusCode).toBe(200);
    const body = set.json() as { ok: true; takenAt: string; counts: Record<string, number> };
    expect(body.counts.patients).toBeGreaterThan(0);
    expect((await configOf()).demoClinic?.baselineAt).toBe(body.takenAt);
    const dry = await api.request('POST', `${P}/clinics/${C}/demo/reset`, { authorization: auth, body: { actor, dryRun: true } });
    expect(dry.json()).toMatchObject({ ok: true, dryRun: true });
    const reset = await api.request('POST', `${P}/clinics/${C}/demo/reset`, { authorization: auth, body: { actor } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ ok: true, dryRun: false, baselineAt: body.takenAt, counts: { patients: { added: 0, changed: 0, missing: 0 } } });
    const state = (await api.request('GET', `${P}/clinics/${C}/demo`, { authorization: auth })).json();
    expect(state).toMatchObject({ enabled: true, baselineAt: body.takenAt, baselineBy: `backoffice:${actor}`, lastResetAt: expect.any(String) });
    // counts only: nothing a caller said or a name
    expect(JSON.stringify(state)).not.toMatch(/data_?enc|v1\./);
  });

  it('turned off: the baseline is kept for when it comes back on, and nothing runs on it', async () => {
    expect((await api.request('PUT', `${P}/clinics/${C}/demo`, { authorization: auth, body: { enabled: false, actor } })).statusCode).toBe(204);
    expect((await configOf()).demoClinic?.enabled).toBe(false);
    expect((await configOf()).demoClinic?.baselineAt).toEqual(expect.any(String));
    expect((await api.request('POST', `${P}/clinics/${C}/demo/reset`, { authorization: auth, body: { actor } })).json()).toEqual({ error: 'not_demo' });
  });
});
