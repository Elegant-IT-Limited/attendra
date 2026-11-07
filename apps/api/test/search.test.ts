import { DEMO_CLINIC } from '@attendra/core';
import { CallRepository, createPhiCipher, PostgresPatientDirectory, PostgresTaskQueue } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

/**
 * Every search box finds a record by every field a person would try (the rule of
 * 2026-11-01): the Pets box and the Calls box, field by field. Made-up names and
 * 555-01xx numbers only.
 */
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const cipher = createPhiCipher(TEST_DATA_KEY);
let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
let waffles: string;
let waffleCall: string;
let strangerCall: string;

const pets = async (query: string) => (await api.request('POST', `${C}/patients/search`, { cookie: staff, body: { query } })).json().patients as { name: string; matchedOn: string }[];
const petNames = async (query: string) => (await pets(query)).map((p) => p.name);
const calls = async (query: string) => (await api.request('POST', `${C}/calls/search`, { cookie: staff, body: { query } })).json().calls as { id: string; patientName: string | null }[];
const callIds = async (query: string) => (await calls(query)).map((c) => c.id).sort();

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  staff = await api.signIn('ana@maple.example', true);
  const directory = new PostgresPatientDirectory(api.t.db, cipher);
  waffles = await directory.create(DEMO_CLINIC.id, { firstName: 'Waffles', lastName: 'Ferreira', dob: '2021-04-09', phone: '+17205550162', guardianName: 'Daniel Ferreira', species: 'dog' });
  await directory.create(DEMO_CLINIC.id, { firstName: 'Mochi', lastName: 'Raman', dob: '2019-08-22', phone: '+17205550165', guardianName: 'Priya Raman', species: 'cat' });
  // a call from the Ferreiras' number, verified as Waffles, that left a request numbered 1042
  const repo = new CallRepository(api.t.db, cipher);
  waffleCall = await repo.open(DEMO_CLINIC.id, 'search_call_1', '+17205550162');
  await repo.recordAction(DEMO_CLINIC.id, waffleCall, { tool: 'find_pet', argsRedacted: {}, result: { verified: true }, taskRevision: 1, patientId: waffles });
  await repo.close(DEMO_CLINIC.id, waffleCall, { reason: 'caller_hangup', voiceSeconds: 30, outcome: 'task_created', emergency: false });
  const { id: taskId } = await new PostgresTaskQueue(api.t.db, cipher).create(DEMO_CLINIC.id, { type: 'callback', callId: waffleCall, patientId: waffles, idempotencyKey: 'search-1042', details: { reason: 'limping' } });
  await api.t.owner.execute(sql`update tasks set number = 1042 where id = ${taskId}`);
  // and a call from a number nobody is on file with: found by its number alone
  strangerCall = await repo.open(DEMO_CLINIC.id, 'search_call_2', '+17205550164');
  await repo.close(DEMO_CLINIC.id, strangerCall, { reason: 'caller_hangup', voiceSeconds: 12, outcome: 'info', emergency: false });
});
afterAll(() => api.close());

describe('the Pets box', () => {
  it('finds a pet by its name', async () => {
    expect(await petNames('waff')).toEqual(['Waffles Ferreira']);
    expect((await pets('waffles'))[0]!.matchedOn).toBe('name');
  });

  it('finds a pet by its owner\'s first name, last name, or both in either order', async () => {
    expect(await petNames('daniel')).toEqual(['Waffles Ferreira']);
    expect(await petNames('ferreira')).toEqual(['Waffles Ferreira']);
    expect(await petNames('daniel ferreira')).toEqual(['Waffles Ferreira']);
    expect(await petNames('ferreira daniel')).toEqual(['Waffles Ferreira']);
    expect((await pets('daniel'))[0]!.matchedOn).toBe('owner');
    expect(await petNames('priya')).toEqual(['Mochi Raman']);
  });

  it('finds a pet by its owner\'s name one letter off, when it sounds the same', async () => {
    expect((await pets('danial')).map((p) => [p.name, p.matchedOn])).toEqual([['Waffles Ferreira', 'owner']]);
    expect(await petNames('ronald')).toEqual([]);
  });

  it('finds a pet by its phone in any form, whole or the last four digits', async () => {
    for (const q of ['(720) 555-0162', '720-555-0162', '7205550162', '0162']) expect(await petNames(q), q).toEqual(['Waffles Ferreira']);
    expect(await petNames('0165')).toEqual(['Mochi Raman']);
  });

  it('finds a pet by its birthday', async () => {
    expect(await petNames('2021-04-09')).toEqual(['Waffles Ferreira']);
    expect(await petNames('April 9 2021')).toEqual(['Waffles Ferreira']);
  });

  it('finds a pet by the number of one of its requests', async () => {
    expect((await pets('R-1042')).map((p) => [p.name, p.matchedOn])).toEqual([['Waffles Ferreira', 'request']]);
    expect((await pets('1042')).map((p) => [p.name, p.matchedOn])).toEqual([['Waffles Ferreira', 'request']]);
    expect(await petNames('R-7')).toEqual([]);
  });

  it('audits by the number of matches, never by what was typed', async () => {
    await pets('danial');
    const rows = (await api.t.owner.execute(sql`select entity_id from audit_logs where action = 'patient.searched' order by id desc limit 1`)).rows;
    expect(rows).toEqual([{ entity_id: 'matches:1' }]);
    expect(JSON.stringify((await api.t.owner.execute(sql`select * from audit_logs`)).rows)).not.toMatch(/danial|waffles|ferreira|5550162/i);
  });
});

describe('the Calls box', () => {
  it('finds a call by the verified pet\'s name and by its owner\'s name', async () => {
    expect(await callIds('waffles')).toEqual([waffleCall]);
    expect(await callIds('daniel')).toEqual([waffleCall]);
    expect(await callIds('ferreira daniel')).toEqual([waffleCall]);
    expect((await calls('waffles'))[0]!.patientName).toBe('Waffles Ferreira');
  });

  it('finds a call by the number it came from, in any form, whole or the last four digits, verified or not', async () => {
    for (const q of ['(720) 555-0162', '720-555-0162', '7205550162', '0162']) expect(await callIds(q), q).toEqual([waffleCall]);
    for (const q of ['+1 720 555 0164', '0164']) expect(await callIds(q), q).toEqual([strangerCall]);
    expect(await callIds('555-016')).toEqual([strangerCall, waffleCall].sort()); // both numbers contain these digits
  });

  it('finds a call by the number of the request it left', async () => {
    expect(await callIds('R-1042')).toEqual([waffleCall]);
    expect(await callIds('1042')).toEqual([waffleCall]);
    expect(await callIds('R-7')).toEqual([]);
  });

  it('audits by the number of matches, never by what was typed', async () => {
    await calls('0162');
    const rows = (await api.t.owner.execute(sql`select entity_id from audit_logs where action = 'calls.searched' order by id desc limit 1`)).rows;
    expect(rows).toEqual([{ entity_id: 'matches:1' }]);
  });
});
