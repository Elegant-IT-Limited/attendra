import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { createPhiCipher, PostgresPatientDirectory } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OTHER, startApi } from './helpers';

const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);
const C = `/api/v1/clinics/${DEMO_CLINIC.id}/patients`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'admin' | 'staff' | 'viewer', string>;

const audit = async (action: string) =>
  ((await api.t.db.execute(sql`select actor, entity_id from audit_logs where action = ${action} order by id`)).rows as { actor: string; entity_id: string }[]);
const search = (query: string, cookie = as.staff) => api.request('POST', `${C}/search`, { cookie, body: { query } });
const names = async (query: string) => (await search(query)).json().patients.map((p: { name: string }) => p.name);

beforeAll(async () => {
  api = await startApi({ demoMode: false, now: () => NOW });
  as = {
    owner: await api.signIn('omar@maple.example', true),
    admin: await api.signIn('olga@maple.example', true),
    staff: await api.signIn('ana@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true),
  };
});
afterAll(() => api.close());

describe('who can see patients', () => {
  it('owners, managers and front desk search, open and add; a viewer does none of it', async () => {
    for (const role of ['owner', 'admin', 'staff'] as const) {
      expect((await search('maria', as[role])).statusCode, role).toBe(200);
      expect((await api.request('GET', `${C}/${api.patientIds.maria}`, { cookie: as[role] })).statusCode, role).toBe(200);
      expect((await api.request('GET', `${C}/recent`, { cookie: as[role] })).statusCode, role).toBe(200);
    }
    expect((await search('maria', as.viewer)).statusCode).toBe(403);
    expect((await api.request('GET', `${C}/${api.patientIds.maria}`, { cookie: as.viewer })).statusCode).toBe(403);
    expect((await api.request('GET', `${C}/recent`, { cookie: as.viewer })).statusCode).toBe(403);
    expect((await api.request('POST', C, { cookie: as.viewer, body: { firstName: 'Val', lastName: 'Viewer', dob: '1990-01-01' } })).statusCode).toBe(403);
    expect((await api.request('PATCH', `${C}/${api.patientIds.maria}`, { cookie: as.viewer, body: { firstName: 'Maria', lastName: 'Delgado', dob: '1985-03-04' } })).statusCode).toBe(403);
  });

  it('another clinic answers 404, even for a real patient id', async () => {
    const O = `/api/v1/clinics/${OTHER.id}/patients`;
    expect((await api.request('POST', `${O}/search`, { cookie: as.owner, body: { query: 'maria' } })).statusCode).toBe(404);
    expect((await api.request('GET', `${O}/${api.patientIds.maria}`, { cookie: as.owner })).statusCode).toBe(404);
    expect((await api.request('GET', `${O}/recent`, { cookie: as.owner })).statusCode).toBe(404);
    expect((await api.request('POST', O, { cookie: as.owner, body: { firstName: 'A', lastName: 'B', dob: '1990-01-01' } })).statusCode).toBe(404);
    expect((await api.request('PATCH', `${O}/${api.patientIds.maria}`, { cookie: as.owner, body: { firstName: 'A', lastName: 'B', dob: '1990-01-01' } })).statusCode).toBe(404);
  });

  it('refuses writes, and the search, from another origin', async () => {
    expect((await api.request('POST', `${C}/search`, { cookie: as.staff, body: { query: 'maria' }, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await api.request('POST', C, { cookie: as.staff, body: { firstName: 'Eve', lastName: 'Evil', dob: '1990-01-01' }, origin: null })).statusCode).toBe(403);
    expect((await api.request('PATCH', `${C}/${api.patientIds.maria}`, { cookie: as.staff, body: { firstName: 'Eve', lastName: 'Evil', dob: '1990-01-01' }, origin: 'https://evil.example' })).statusCode).toBe(403);
  });
});

describe('search', () => {
  it('finds by name in any order and case, by a word\'s start', async () => {
    expect(await names('maria delgado')).toEqual(['Maria Delgado']);
    expect(await names('DEL mar')).toEqual(['Maria Delgado']);
    expect(await names('rivera')).toEqual(['Sam Rivera', 'Sam Rivera']);
    expect(await names('delgato')).toEqual([]);
  });

  it('finds by date of birth written any common way', async () => {
    for (const q of ['1985-03-04', '03/04/1985', 'March 4 1985', '4 March 1985']) expect(await names(q), q).toEqual(['Maria Delgado']);
  });

  it('finds by a full phone number through its hash, with any punctuation', async () => {
    expect(await names('(303) 555-0163')).toEqual(['James Whitaker']);
    expect(await names('+1 303 555 0163')).toEqual(['James Whitaker']);
  });

  it('audits the number of matches and never what was typed', async () => {
    await search('whitaker');
    const last = (await audit('patient.searched')).at(-1)!;
    expect(last).toEqual({ actor: `user:${api.users.staff}`, entity_id: 'matches:1' });
    expect((await audit('patient.search.result')).at(-1)).toEqual({ actor: `user:${api.users.staff}`, entity_id: api.patientIds.james });
    const dump = JSON.stringify((await api.t.db.execute(sql`select * from audit_logs`)).rows);
    // the phone number as it would be written; four digits alone turn up by chance in random ids
    expect(dump).not.toMatch(/whitaker|delgado|5550163/i);
  });

  it('answers from the first character typed: the start of a name, or any digits of a phone number', async () => {
    expect(await names('m')).toEqual(expect.arrayContaining(['Maria Delgado']));
    expect(await names('017')).toEqual(['Sam Rivera', 'Sam Rivera']); // 303 555 0171 and 0172
    expect(await names('999')).toEqual([]);
    expect(await names('555-016')).toEqual(['James Whitaker']);
    expect((await api.request('POST', `${C}/search`, { cookie: as.staff, body: {} })).json().error).toBe('invalid_request');
  });
});

describe('a patient\'s record', () => {
  it('shows contact details, appointments, verified calls and requests, audited', async () => {
    await api.t.db.execute(sql`update calls set patient_id = ${api.patientIds.maria!} where id = ${api.callId}`);
    const p = (await api.request('GET', `${C}/${api.patientIds.maria}`, { cookie: as.staff })).json();
    expect(p).toMatchObject({ name: 'Maria Delgado', dob: '1985-03-04', phone: '+13035550147', appointments: [] });
    expect(p.calls).toEqual([expect.objectContaining({ id: api.callId, outcome: 'task_created' })]);
    expect(p.requests).toEqual([expect.objectContaining({ id: api.taskId, type: 'refill', details: expect.objectContaining({ medication: 'lisinopril' }) })]);
    expect((await audit('patient.viewed')).at(-1)).toEqual({ actor: `user:${api.users.staff}`, entity_id: api.patientIds.maria });
    expect((await api.request('GET', `${C}/00000000-0000-4000-8000-000000000000`, { cookie: as.staff })).statusCode).toBe(404);
    expect((await api.request('GET', `${C}/not-a-uuid`, { cookie: as.staff })).statusCode).toBe(404);
  });

  it('lists the patients this person opened last, newest first, and nobody else\'s', async () => {
    await api.request('GET', `${C}/${api.patientIds.james}`, { cookie: as.staff });
    expect((await api.request('GET', `${C}/recent`, { cookie: as.staff })).json().patients.map((p: { name: string }) => p.name)).toEqual(['James Whitaker', 'Maria Delgado']);
    // the owner opened only Maria, in the role test above
    expect((await api.request('GET', `${C}/recent`, { cookie: as.owner })).json().patients.map((p: { name: string }) => p.name)).toEqual(['Maria Delgado']);
  });
});

describe('adding and editing', () => {
  const directory = () => new PostgresPatientDirectory(api.t.db, createPhiCipher(TEST_DATA_KEY));
  let id: string;

  it('adds a patient the assistant can then verify on a call', async () => {
    const res = await api.request('POST', C, { cookie: as.staff, body: { firstName: 'Nora', lastName: 'Quinlan', dob: '1971-06-18', phone: '(303) 555-0188', gender: 'female' } });
    expect(res.statusCode).toBe(201);
    id = res.json().id;
    expect(await directory().findByIdentity(DEMO_CLINIC.id, 'Nora Quinlan', '1971-06-18', '3035550188')).toMatchObject({ status: 'found', patient: { id, phone: '(303) 555-0188' } });
    expect(await names('3035550188')).toEqual(['Nora Quinlan']);
    expect((await audit('patient.created')).filter((a) => a.entity_id === id)).toEqual([{ actor: `user:${api.users.staff}`, entity_id: id }]);
    const stored = JSON.stringify((await api.t.db.execute(sql`select * from patients where id = ${id}`)).rows);
    expect(stored).not.toMatch(/Nora|Quinlan|1971/);
  });

  it('refuses the same person twice (name, date of birth and phone), and adds a different person who shares a name and birthday', async () => {
    const res = await api.request('POST', C, { cookie: as.admin, body: { firstName: 'maria', lastName: 'DELGADO', dob: '1985-03-04', phone: '303-555-0147', gender: 'female' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'patient_exists', id: api.patientIds.maria });
    const other = await api.request('POST', C, { cookie: as.admin, body: { firstName: 'Maria', lastName: 'Delgado', dob: '1985-03-04', phone: '303-555-0177', gender: 'female' } });
    expect(other.statusCode).toBe(201);
    expect(other.json()).toMatchObject({ similar: true });
  });

  it('needs a gender for everyone, stores it encrypted, and shows it', async () => {
    const noGender = await api.request('POST', C, { cookie: as.staff, body: { firstName: 'Gia', lastName: 'Nogender', dob: '1990-01-01', phone: '303-555-0146' } });
    expect(noGender.json().issues[0]).toMatchObject({ path: 'gender' });
    const res = await api.request('POST', C, { cookie: as.staff, body: { firstName: 'Gia', lastName: 'Gender', dob: '1990-01-01', phone: '303-555-0146', gender: 'undisclosed' } });
    expect((await api.request('GET', `${C}/${res.json().id}`, { cookie: as.staff })).json().gender).toBe('undisclosed');
    expect(JSON.stringify((await api.t.db.execute(sql`select gender_enc from patients where id = ${res.json().id}`)).rows)).not.toContain('undisclosed');
  });

  it('needs a phone number for everyone, and a parent or guardian for anyone under 18', async () => {
    const noPhone = await api.request('POST', C, { cookie: as.staff, body: { firstName: 'Pat', lastName: 'Nophone', dob: '1990-01-01' } });
    expect(noPhone.json().issues[0]).toMatchObject({ path: 'phone' });
    const child = await api.request('POST', C, { cookie: as.staff, body: { firstName: 'Leo', lastName: 'Delgado', dob: '2022-08-01', phone: '303-555-0147', gender: 'female' } });
    expect(child.json().issues[0]).toMatchObject({ path: 'guardianName' });
    const ok = await api.request('POST', C, { cookie: as.staff, body: { firstName: 'Leo', lastName: 'Delgado', dob: '2022-08-01', phone: '303-555-0147', gender: 'female', guardianName: 'Maria Delgado' } });
    expect(ok.statusCode).toBe(201);
    // the family on one phone, on the parent's record
    const maria = (await api.request('GET', `${C}/${api.patientIds.maria}`, { cookie: as.staff })).json();
    expect(maria.household.map((p: { firstName: string }) => p.firstName)).toEqual(['Lucas', 'Leo', 'Sofia']);
  });

  it('edits a patient and keeps the voice lookup right: the new name and phone verify, the old ones do not', async () => {
    const res = await api.request('PATCH', `${C}/${id}`, { cookie: as.owner, body: { firstName: 'Nora', lastName: 'Quinlan-Hart', dob: '1971-06-18', phone: '(303) 555-0189', gender: 'female' } });
    expect(res.json()).toEqual({ id, similar: false });
    expect(await directory().findByIdentity(DEMO_CLINIC.id, 'Nora Quinlan-Hart', '1971-06-18', '3035550189')).toMatchObject({ status: 'found', patient: { id, phone: '(303) 555-0189' } });
    expect(await directory().findByIdentity(DEMO_CLINIC.id, 'Nora Quinlan', '1971-06-18', '3035550188')).toEqual({ status: 'not_found' });
    expect(await names('3035550188')).toEqual([]);
    expect(await audit('patient.updated')).toEqual([{ actor: `user:${api.users.owner}`, entity_id: id }]);
    expect((await api.request('PATCH', `${C}/${id}`, { cookie: as.owner, body: { firstName: 'Maria', lastName: 'Delgado', dob: '1985-03-04', phone: '+13035550147', gender: 'female' } })).statusCode).toBe(409);
  });

  it('judges a date of birth "in the future" by the clinic\'s date, not the server\'s', async () => {
    // 8 pm on Monday 28 September in Denver is already Tuesday the 29th in UTC
    const tomorrowThere = await api.request('POST', C, { cookie: as.staff, body: { firstName: 'Baby', lastName: 'Early', dob: '2026-09-29', phone: '303-555-0140', gender: 'female', guardianName: 'Pat Early' } });
    expect(tomorrowThere.statusCode).toBe(422);
    expect(tomorrowThere.json().issues[0]).toMatchObject({ path: 'dob', message: 'a date of birth cannot be in the future' });
    expect((await api.request('POST', C, { cookie: as.staff, body: { firstName: 'Baby', lastName: 'Today', dob: '2026-09-28', phone: '303-555-0141', gender: 'female', guardianName: 'Pat Today' } })).statusCode).toBe(201);
  });

  it('validates the details', async () => {
    for (const body of [
      { firstName: '', lastName: 'X', dob: '1990-01-01' },
      { firstName: 'X', lastName: 'Y', dob: '01/01/1990' },
      { firstName: 'X', lastName: 'Y', dob: '1990-01-01', phone: '555' },
      { firstName: 'X'.repeat(81), lastName: 'Y', dob: '1990-01-01' },
    ]) {
      expect((await api.request('POST', C, { cookie: as.staff, body })).json().error, JSON.stringify(body)).toBe('invalid_request');
    }
    expect((await api.request('PATCH', `${C}/00000000-0000-4000-8000-000000000000`, { cookie: as.staff, body: { firstName: 'X', lastName: 'Y', dob: '1990-01-01', phone: '303-555-0142', gender: 'female' } })).statusCode).toBe(404);
  });

  it('lists the newest patients first before anything is typed', async () => {
    const list = (await api.request('GET', C, { cookie: as.staff })).json().patients;
    expect(list[0].name).toBe('Baby Today');
    expect(new Date(list[0].createdAt) >= new Date(list.at(-1).createdAt)).toBe(true);
  });
});

describe('patients the assistant adds', () => {
  it('are marked new, listed for checking, and become ordinary patients once confirmed', async () => {
    const directory = new PostgresPatientDirectory(api.t.db, createPhiCipher(TEST_DATA_KEY));
    const added = await directory.register(DEMO_CLINIC.id, { firstName: 'Ines', lastName: 'Park', dob: '1999-12-01', gender: 'female', phone: '+13035550143', guardianName: null, callId: api.callId });
    const waiting = (await api.request('GET', `${C}?status=new`, { cookie: as.staff })).json().patients;
    expect(waiting.map((p: { name: string; status: string }) => [p.name, p.status])).toEqual([['Ines Park', 'new']]);
    expect((await api.request('POST', `${C}/${added.patient.id}/confirm`, { cookie: as.staff })).statusCode).toBe(204);
    expect((await api.request('GET', `${C}?status=new`, { cookie: as.staff })).json().patients).toEqual([]);
    expect((await audit('patient.confirmed')).at(-1)).toEqual({ actor: `user:${api.users.staff}`, entity_id: added.patient.id });
  });
});

describe('importing patients from a spreadsheet', () => {
  const csv = [
    'first_name,last_name,date_of_birth,gender,phone,guardian_name',
    'Rosa,Ibanez,1979-02-11,female,+1 303 555 0144,',
    'Tom,Ibanez,2018-04-04,male,+1 303 555 0144,Rosa Ibanez',
    'Kid,Noguardian,2019-01-01,male,+1 303 555 0145,',
    'Maria,Delgado,1985-03-04,female,+1 303 555 0147,',
    'Rosa,Ibanez,02/11/1979,F,303-555-0144,',
  ].join('\n');

  it('is for managers only', async () => {
    expect((await api.request('POST', `${C}/import`, { cookie: as.staff, body: { csv, dryRun: true } })).statusCode).toBe(403);
  });

  it('checks every row first, then adds the new patients, skips the ones on file, and can run twice', async () => {
    const dry = (await api.request('POST', `${C}/import`, { cookie: as.admin, body: { csv, dryRun: true } })).json();
    expect(dry.rows.map((r: { status: string }) => r.status)).toEqual(['add', 'add', 'error', 'skip', 'error']);
    expect(dry.rows[2].message).toMatch(/guardian/);
    expect(dry.rows[4].message).toMatch(/twice/);
    expect((await names('ibanez'))).toEqual([]); // a dry run changes nothing
    const real = (await api.request('POST', `${C}/import`, { cookie: as.admin, body: { csv, dryRun: false } })).json();
    expect(real.counts).toEqual({ add: 2, update: 0, skip: 1, error: 2 });
    expect(await names('ibanez')).toEqual(['Rosa Ibanez', 'Tom Ibanez']);
    const again = (await api.request('POST', `${C}/import`, { cookie: as.admin, body: { csv, dryRun: false } })).json();
    expect(again.counts).toEqual({ add: 0, update: 0, skip: 3, error: 2 });
  });
});

describe('calls and patients', () => {
  it('names the verified patient on the call page', async () => {
    const call = (await api.request('GET', `/api/v1/clinics/${DEMO_CLINIC.id}/calls/${api.callId}`, { cookie: as.staff })).json();
    expect(call.patient).toEqual({ id: api.patientIds.maria, name: 'Maria Delgado' });
  });
});
