// SPDX-License-Identifier: AGPL-3.0-only
import { ClinicConfig, DEMO_CLINIC, HANDOFF_LABELS, maskExcerptLine } from '@attendra/core';
import { createPhiCipher, recordHandoff, schema, withClinic } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// Note 47: the handoff review loop's routes, for the hosting layer's back office. Codes only, except the one excerpt a
// reviewer opens (masked before it was stored); every view and verdict is an audit row. Made-up details only.
const TOKEN = 'p'.repeat(40);
const auth = `Bearer ${TOKEN}`;
const P = '/api/v1/provisioning';
const C = DEMO_CLINIC.id;
let api: Awaited<ReturnType<typeof startApi>>;
const cipher = createPhiCipher(TEST_DATA_KEY);
const names = { people: ['Maria Delgado'], pets: ['Biscuit'], vets: [] };
let first: string;
let second: string;

beforeAll(async () => {
  api = await startApi({ demoMode: false, twoFactor: 'optional', provisioningToken: TOKEN });
  first = await recordHandoff(api.t.db, cipher, C, api.callId, {
    kind: 'callback', reason: 'identity_not_verified', lineId: 'callback_taken', at: new Date('2026-11-10T10:00:00Z'),
    steps: [{ tool: 'verify_caller', result: 'number_not_opened' }, { tool: 'verify_caller', result: 'number_not_opened' }, { tool: 'create_callback', result: 'ok' }],
    excerpt: [{ speaker: 'caller', text: maskExcerptLine('This is Maria Delgado, about Biscuit, my number is 303 555 0147.', names) }],
  });
  second = await recordHandoff(api.t.db, cipher, C, api.callId, { kind: 'no_answer', reason: 'no_answer_in_clinic_info', lineId: 'no_information', steps: [], excerpt: null, at: new Date('2026-11-11T10:00:00Z') });
});
afterAll(() => api.close());

describe('the handoff review routes', () => {
  it('need the provisioning token', async () => {
    expect((await api.request('GET', `${P}/handoffs`)).statusCode).toBe(401);
    expect((await api.request('PUT', `${P}/clinics/${C}/handoffs/${first}/verdict`, { body: { verdict: 'needed', fixCategory: null, by: 'a@example.com' } })).statusCode).toBe(401);
  });

  it('list handoffs across clinics, newest first, codes only, with the labels for each code', async () => {
    const res = await api.request('GET', `${P}/handoffs`, { authorization: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { handoffs: { id: string; kind: string; reason: string; engine: string; hasExcerpt: boolean; clinicName: string; steps: unknown[] }[]; labels: typeof HANDOFF_LABELS };
    expect(body.handoffs.map((h) => h.id)).toEqual([second, first]);
    expect(body.handoffs[1]).toMatchObject({ kind: 'callback', reason: 'identity_not_verified', hasExcerpt: true, clinicName: DEMO_CLINIC.name, steps: expect.any(Array) });
    expect(JSON.stringify(body)).not.toContain('Maria');
    expect(JSON.stringify(body)).not.toContain('0147');
    expect(body.labels).toEqual(HANDOFF_LABELS);
    const filtered = (await api.request('GET', `${P}/handoffs?reason=identity_not_verified&verdict=unreviewed`, { authorization: auth })).json() as { handoffs: { id: string }[] };
    expect(filtered.handoffs.map((h) => h.id)).toEqual([first]);
    expect((await api.request('GET', `${P}/handoffs?reason=made_up`, { authorization: auth })).statusCode).toBe(422);
    // an account's locations, as the back office sends them
    expect(((await api.request('GET', `${P}/handoffs?clinicIds=${C},clinic_none`, { authorization: auth })).json() as { handoffs: unknown[] }).handoffs).toHaveLength(2);
    expect(((await api.request('GET', `${P}/handoffs?clinicIds=clinic_none`, { authorization: auth })).json() as { handoffs: unknown[] }).handoffs).toHaveLength(0);
  });

  it('open one with its masked excerpt, and the view is audited with the reviewer\'s email', async () => {
    const res = await api.request('GET', `${P}/clinics/${C}/handoffs/${first}?viewer=reviewer@example.com`, { authorization: auth });
    expect(res.statusCode).toBe(200);
    const { handoff } = res.json() as { handoff: { excerpt: { speaker: string; text: string }[] } };
    expect(handoff.excerpt).toEqual([{ speaker: 'caller', text: 'This is [name] [name], about [pet], my number is …0147.' }]);
    const audits = await withClinic(api.t.db, C, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.clinicId, C), eq(schema.auditLogs.action, 'handoff.viewed'))));
    expect(audits).toEqual([expect.objectContaining({ actor: 'backoffice:reviewer@example.com', entity: 'handoff', entityId: first })]);
    expect((await api.request('GET', `${P}/clinics/${C}/handoffs/${first}`, { authorization: auth })).statusCode).toBe(422);
    expect((await api.request('GET', `${P}/clinics/${C}/handoffs/not-a-uuid?viewer=reviewer@example.com`, { authorization: auth })).statusCode).toBe(404);
    expect((await api.request('GET', `${P}/clinics/clinic_other/handoffs/${first}?viewer=reviewer@example.com`, { authorization: auth })).statusCode).toBe(404);
  });

  it('set a verdict and a fix category, audited; then the numbers and the weekly "not needed" export count it', async () => {
    expect((await api.request('PUT', `${P}/clinics/${C}/handoffs/${first}/verdict`, { authorization: auth, body: { verdict: 'not_needed', fixCategory: 'agent_rule', by: 'reviewer@example.com' } })).statusCode).toBe(204);
    expect((await api.request('PUT', `${P}/clinics/${C}/handoffs/${first}/verdict`, { authorization: auth, body: { verdict: 'maybe', fixCategory: null, by: 'reviewer@example.com' } })).statusCode).toBe(422);
    const audits = await withClinic(api.t.db, C, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.clinicId, C), eq(schema.auditLogs.action, 'handoff.reviewed.not_needed'))));
    expect(audits).toHaveLength(1);
    const range = `from=${encodeURIComponent('2026-11-01T00:00:00Z')}&to=${encodeURIComponent('2030-01-01T00:00:00Z')}`;
    const weeks = (await api.request('GET', `${P}/handoffs/weeks?${range}`, { authorization: auth })).json() as { weeks: { week: string; handoffs: number; reviewed: number; notNeeded: number; reasons: { reason: string; count: number }[] }[] };
    expect(weeks.weeks.reduce((s, w) => s + w.handoffs, 0)).toBe(2);
    expect(weeks.weeks.reduce((s, w) => s + w.notNeeded, 0)).toBe(1);
    const exported = (await api.request('GET', `${P}/handoffs/not-needed?${range}`, { authorization: auth })).json() as { handoffs: { id: string; reason: string; fixCategory: string; hasExcerpt: boolean }[] };
    expect(exported.handoffs).toEqual([expect.objectContaining({ id: first, reason: 'identity_not_verified', fixCategory: 'agent_rule' })]);
    expect(JSON.stringify(exported)).not.toContain('excerpt"');
  });

  it('switch a clinic\'s excerpts on and off from the hosting layer only; a Settings save keeps the switch', async () => {
    expect((await api.request('PUT', `${P}/clinics/${C}/handoff-excerpts`, { authorization: auth, body: { on: true } })).statusCode).toBe(204);
    const [row] = await api.t.db.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, C));
    expect(ClinicConfig.parse(row!.config).handoffExcerpts).toBe(true);
    expect((await api.request('PUT', `${P}/clinics/clinic_missing/handoff-excerpts`, { authorization: auth, body: { on: true } })).statusCode).toBe(404);
    // the owner saves Settings with the flag off in the body: the hosting layer's value stays
    const cookie = await api.signIn('omar@maple.example', true);
    const read = await api.request('GET', `/api/v1/clinics/${C}/settings`, { cookie });
    const saved = await api.request('PUT', `/api/v1/clinics/${C}/settings`, { cookie, body: { ...(read.json() as object), handoffExcerpts: false }, headers: { 'if-match': read.headers.etag as string } });
    expect(saved.statusCode).toBe(200);
    const [after] = await api.t.db.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, C));
    expect(ClinicConfig.parse(after!.config).handoffExcerpts).toBe(true);
  });
});
