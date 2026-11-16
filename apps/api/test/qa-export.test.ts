import { DEMO_CLINIC, localDateOf } from '@attendra/core';
import { CallEventLog, CallRepository, createPhiCipher } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QaExport } from '../src/contracts';
import { QA_EXPORT_LIMIT } from '../src/qa/qa.controller';
import { OTHER, startApi } from './helpers';

// Foundation A, item 1: the QA read path. A daily, read-only export of a clinic's calls with a key scoped qa:read.
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const TODAY = localDateOf(new Date(), DEMO_CLINIC.timezone);
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'admin' | 'staff' | 'outsider', string>;
let qaKey: { id: string; key: string };
let callId: string;

const makeKey = async (scopes: string[], name = 'QA reviewer') => {
  const res = await api.request('POST', `${C}/api-keys`, { cookie: as.owner, body: { name, scopes, expiresInDays: 30 } });
  expect(res.statusCode).toBe(201);
  return { id: res.json().apiKey.id as string, key: res.json().key as string };
};
const exportWith = (key: string, path = `${C}/qa/export?day=${TODAY}`) => api.request('GET', path, { authorization: `Bearer ${key}`, origin: null });
const audits = async (action: string) => (await api.t.owner.execute(sql`select actor, entity, entity_id, counts from audit_logs where clinic_id = ${DEMO_CLINIC.id} and action = ${action} order by id`)).rows as Record<string, unknown>[];

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  as = { owner: await api.signIn('omar@maple.example', true), admin: await api.signIn('olga@maple.example', true), staff: await api.signIn('ana@maple.example', true), outsider: await api.signIn('otto@other.example', true) };
  qaKey = await makeKey(['qa:read']);
  // a call on path A today, with numbers said and a pet's date of birth, and its event log
  const calls = new CallRepository(api.t.db, createPhiCipher(TEST_DATA_KEY));
  callId = await calls.open(DEMO_CLINIC.id, 'qa_export_call', '+13035550147', 'phone', undefined, undefined, { engine: 'gpt-realtime', voiceFlow: 'tools' });
  const lines = [
    { speaker: 'caller' as const, text: 'Hi, this is Maria Delgado, my number is 303-555-0147.', startMs: 0, endMs: 2000 },
    { speaker: 'agent' as const, text: 'Thanks Maria. When was Biscuit born?', startMs: 2600, endMs: 4000 },
    { speaker: 'caller' as const, text: 'March 3rd, 2019. The code on the card is 4821.', startMs: 4500, endMs: 6000 },
    { speaker: 'agent' as const, text: 'Biscuit is booked for Tuesday at 9:30.', startMs: 6800, endMs: 9000 },
  ];
  for (const l of lines) await calls.appendSegment(DEMO_CLINIC.id, callId, l);
  await calls.recordAction(DEMO_CLINIC.id, callId, { tool: 'find_slots', argsRedacted: [], result: { ok: false, error: 'fully_booked' }, taskRevision: 1 });
  await calls.close(DEMO_CLINIC.id, callId, { reason: 'caller_hangup', voiceSeconds: 9, outcome: 'booked', emergency: false, quality: { firstAudioMs: 700, stalls: 0, answerTimeouts: 0 } });
  let clock = 0;
  const log = new CallEventLog(api.t.db, DEMO_CLINIC.id, callId, 'gpt-realtime/tools', { flushMs: 60_000, now: () => clock });
  for (const [at, type] of [[2000, 'input_audio_buffer.speech_stopped'], [2100, 'gate.sent.reply'], [2600, 'output_audio_buffer.started'], [6000, 'input_audio_buffer.speech_stopped'], [6100, 'error'], [6150, 'gate.cleared_on_error'], [6800, 'output_audio_buffer.started']] as const) {
    clock = at;
    log.add(type === 'error' ? { type, errorCode: 'invalid_value', errorType: 'invalid_request_error' } : { type });
  }
  await log.close();
}, 60_000);
afterAll(() => api.close());

describe('the QA export', () => {
  it('reads a day of calls with a qa:read key: codes, the event-log summary, the numbers, and the transcript with numbers masked', async () => {
    const res = await exportWith(qaKey.key);
    expect(res.statusCode).toBe(200);
    const body = QaExport.parse(res.json());
    expect(body).toMatchObject({ day: TODAY, timezone: DEMO_CLINIC.timezone, truncated: false });
    const call = body.calls.find((c) => c.id === callId)!;
    expect(call).toMatchObject({ path: 'gpt-realtime/tools', endReason: 'caller_hangup', outcome: 'booked', testCall: false, requests: [], bookings: [], texts: [] });
    expect(call.events).toMatchObject({ callerTurns: 2, stalls: 0, replyMs: [600, 800], gate: { 'gate.sent.reply': 1, 'gate.cleared_on_error': 1 }, errors: { 'invalid_request_error/invalid_value': 1 } });
    expect(call.transcript!.map((l) => [l.speaker, l.text])).toEqual([
      ['caller', 'Hi, this is Maria Delgado, my number is [number].'],
      ['assistant', 'Thanks Maria. When was Biscuit born?'],
      ['caller', '[date]. The code on the card is [number].'],
      ['assistant', 'Biscuit is booked for Tuesday at 9:30.'],
    ]);
    // the masking holds for every transcript in the answer: no phone number, year or code (ids are hex, so not checked)
    const words = JSON.stringify(body.calls.map((c) => c.transcript));
    for (const digits of ['0147', '555', '2019', '4821', '303']) expect(words).not.toContain(digits);
    // the setup call's refill request is listed by kind and status only
    const setup = body.calls.find((c) => c.id === api.callId)!;
    expect(setup.requests).toEqual([{ number: expect.any(Number), kind: 'refill', status: 'open', urgent: false, origin: null, outcome: null }]);
    // a request's details (the pharmacy, the callback number) are never in it
    expect(res.body).not.toContain('Main St');
    const path = body.numbers.find((p) => p.path === 'gpt-realtime/tools')!;
    expect(path.replyMs).toMatchObject({ status: 'measured', p50: 600, p90: 800, n: 2 });
    expect(path.yesDisagreements).toEqual({ status: 'not_measured', reason: expect.stringContaining('batch B') });
  });

  it('audits every read under the key, with counts only, and marks the key used', async () => {
    const before = (await audits('qa.export')).length;
    expect((await exportWith(qaKey.key)).statusCode).toBe(200);
    const rows = await audits('qa.export');
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ actor: `api_key:${qaKey.id}`, entity: 'api_key', entity_id: qaKey.id, counts: { calls: expect.any(Number), lines: expect.any(Number) } });
    const used = (await api.t.owner.execute(sql`select last_used_at from api_keys where id = ${qaKey.id}`)).rows[0] as { last_used_at: unknown };
    expect(used.last_used_at).not.toBeNull();
    // a manager's own read is audited as theirs
    expect((await api.request('GET', `${C}/qa/export?day=${TODAY}`, { cookie: as.admin })).statusCode).toBe(200);
    expect((await audits('qa.export')).at(-1)).toMatchObject({ actor: expect.stringMatching(/^user:/), entity: 'clinic', entity_id: DEMO_CLINIC.id });
  });

  it('a key without qa:read gets 403, audited; an unknown or revoked key 401', async () => {
    const other = await makeKey(['schedule:read', 'quality:read'], 'Desktop MCP client');
    const res = await exportWith(other.key);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden', message: 'this key does not have qa:read' });
    expect((await audits('api_key.refused.qa:read')).at(-1)).toMatchObject({ actor: `api_key:${other.id}` });
    expect((await exportWith(`atk_${'x'.repeat(43)}`)).statusCode).toBe(401);
    const gone = await makeKey(['qa:read'], 'Revoked reviewer');
    expect((await api.request('DELETE', `${C}/api-keys/${gone.id}`, { cookie: as.owner })).statusCode).toBe(204);
    expect((await exportWith(gone.key)).statusCode).toBe(401);
  });

  it('a qa:read key reads nothing else: not another clinic, not another route, and it can never write', async () => {
    expect((await exportWith(qaKey.key, `/api/v1/clinics/${OTHER.id}/qa/export?day=${TODAY}`)).statusCode).toBe(404);
    expect((await exportWith(qaKey.key, `${C}/calls`)).statusCode).toBe(401);
    expect((await exportWith(qaKey.key, `${C}/quality`)).statusCode).toBe(401);
    for (const [method, path, body] of [['POST', `${C}/api-keys`, { name: 'x', scopes: ['qa:read'] }], ['PUT', `${C}/settings`, {}], ['DELETE', `${C}/api-keys/${qaKey.id}`, undefined]] as const) {
      const res = await api.request(method, path, { authorization: `Bearer ${qaKey.key}`, body });
      expect([401, 403]).toContain(res.statusCode);
    }
    expect((await api.request('GET', `${C}/api-keys`, { cookie: as.owner })).json().keys.find((k: { id: string }) => k.id === qaKey.id).status).toBe('active');
  });

  it('is for owners and managers when signed in; staff 403, another clinic\'s owner 404', async () => {
    expect((await api.request('GET', `${C}/qa/export?day=${TODAY}`, { cookie: as.owner })).statusCode).toBe(200);
    expect((await api.request('GET', `${C}/qa/export?day=${TODAY}`, { cookie: as.staff })).statusCode).toBe(403);
    expect((await api.request('GET', `${C}/qa/export?day=${TODAY}`, { cookie: as.outsider })).statusCode).toBe(404);
    expect((await api.request('GET', `${C}/qa/export?day=${TODAY}`)).statusCode).toBe(401);
  });

  it('takes the clinic\'s day, yesterday by default, and refuses one that is not a day', async () => {
    const res = await exportWith(qaKey.key, `${C}/qa/export`);
    expect(res.statusCode).toBe(200);
    expect(res.json().day).not.toBe(TODAY);
    expect(res.json().calls.map((c: { id: string }) => c.id)).not.toContain(callId);
    for (const day of ['2026-13-01', '2026-02-30', 'yesterday', '2026-1-5']) expect((await exportWith(qaKey.key, `${C}/qa/export?day=${day}`)).statusCode).toBe(422);
  });

  it('is rate-limited per key, with a retry-after', async () => {
    const busy = await makeKey(['qa:read'], 'Busy reviewer');
    for (let i = 0; i < QA_EXPORT_LIMIT.max; i++) expect((await exportWith(busy.key, `${C}/qa/export?day=2026-01-01`)).statusCode).toBe(200);
    const res = await exportWith(busy.key, `${C}/qa/export?day=2026-01-01`);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // another key has its own budget
    expect((await exportWith(qaKey.key, `${C}/qa/export?day=2026-01-01`)).statusCode).toBe(200);
  });

  it('is in the OpenAPI document', async () => {
    const doc = (await api.request('GET', '/api/docs-json')).json();
    expect(Object.keys(doc.paths)).toContain('/api/v1/clinics/{clinicId}/qa/export');
  });
});
