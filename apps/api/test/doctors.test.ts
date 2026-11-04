import { allVisitTypeIds, ClinicConfig, DEMO_CLINIC, noProviderWarnings, zonedInstant } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);
const C = `/api/v1/clinics/${DEMO_CLINIC.id}/doctors`;
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<'owner' | 'admin' | 'staff' | 'viewer', string>;

const stored = async () => ClinicConfig.parse(((await api.t.db.execute(sql`select config from clinics where id = ${DEMO_CLINIC.id}`)).rows[0] as { config: unknown }).config);
const kim = {
  name: 'Dr. Jae Kim', gender: 'male', specialty: 'Pediatrics', categories: ['Children', 'Vaccinations'], ages: { min: 0, max: 17 }, acceptingNewPatients: true,
  visitTypeIds: ['vt_sick', 'vt_new'], hours: { '1': [{ open: '09:00', close: '13:00' }] }, timeOff: [{ from: '2026-12-24', to: '2026-12-31' }],
};

beforeAll(async () => {
  api = await startApi({ demoMode: false, now: () => NOW, changes: true });
  as = {
    owner: await api.signIn('omar@maple.example', true),
    admin: await api.signIn('olga@maple.example', true),
    staff: await api.signIn('ana@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true),
  };
});
afterAll(() => api.close());

describe('doctors', () => {
  let id: string;

  it('refuses a phone typed with letters, under its field, in plain words', async () => {
    const res = await api.request('POST', C, { cookie: as.owner, body: { ...kim, name: 'Lettered Vet', phone: '303 CALL NOW' } });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json().issues)).toContain('Use numbers only, for example (555) 555-0123.');
    const settings = await api.request('GET', `/api/v1/clinics/${DEMO_CLINIC.id}/settings`, { cookie: as.owner });
    const body = { ...settings.json(), vipCallers: [{ name: 'Partner', phone: '303 555 VIP1' }] };
    const saved = await api.request('PUT', `/api/v1/clinics/${DEMO_CLINIC.id}/settings`, { cookie: as.owner, body });
    expect(saved.statusCode).toBe(422);
    expect(saved.json().issues).toEqual([{ path: 'vipCallers.0.phone', message: 'Use numbers only, for example (555) 555-0123.' }]);
  });

  it('everyone on the team can see them; only managers change them', async () => {
    for (const role of ['owner', 'admin', 'staff', 'viewer'] as const) expect((await api.request('GET', C, { cookie: as[role] })).statusCode, role).toBe(200);
    expect((await api.request('POST', C, { cookie: as.staff, body: kim })).statusCode).toBe(403);
  });

  it('adds a doctor with a specialty, the ages they see, weekly hours and days off, under a new id', async () => {
    const res = await api.request('POST', C, { cookie: as.admin, body: kim });
    expect(res.statusCode).toBe(201);
    // saved without the title typed before the name: "Dr." is said, not stored
    const added = res.json().providers.find((p: { name: string }) => p.name === 'Jae Kim');
    id = added.id;
    expect(id).toMatch(/^prov_jae_kim_[a-z0-9]{4}$/);
    expect((await stored()).providers.find((p) => p.id === id)).toMatchObject({ specialty: 'Pediatrics', ages: { min: 0, max: 17 }, timeOff: [{ from: '2026-12-24', to: '2026-12-31' }] });
    const audit = (await api.t.db.execute(sql`select actor, entity_id from audit_logs where action = 'clinic.doctor.added'`)).rows;
    expect(audit).toEqual([{ actor: `user:${api.users.admin}`, entity_id: id }]);
  });

  it('changes one, and refuses what Settings would refuse', async () => {
    const res = await api.request('PUT', `${C}/${id}`, { cookie: as.owner, body: { ...kim, acceptingNewPatients: false } });
    expect(res.json().providers.find((p: { id: string }) => p.id === id).acceptingNewPatients).toBe(false);
    expect((await api.request('PUT', `${C}/${id}`, { cookie: as.owner, body: { ...kim, visitTypeIds: ['vt_nope'] } })).statusCode).toBe(422);
    expect((await api.request('PUT', `${C}/${id}`, { cookie: as.owner, body: { ...kim, ages: { min: 18, max: 2 } } })).statusCode).toBe(422);
    expect((await api.request('PUT', `${C}/prov_nobody`, { cookie: as.owner, body: kim })).statusCode).toBe(404);
  });

  it('gives a new doctor every visit type when none are sent, and a change without them keeps theirs', async () => {
    const unsent: Partial<typeof kim> = { ...kim };
    delete unsent.visitTypeIds;
    const added = await api.request('POST', C, { cookie: as.owner, body: { ...unsent, name: 'Dr. Mira Sol' } });
    expect(added.statusCode).toBe(201);
    const sol = added.json().providers.find((p: { name: string }) => p.name === 'Mira Sol');
    expect(sol.visitTypeIds).toEqual(allVisitTypeIds(await stored()));
    expect((await api.request('PUT', `${C}/${sol.id}`, { cookie: as.owner, body: { ...unsent, name: 'Dr. Mira Sol', visitTypeIds: ['vt_sick'] } })).statusCode).toBe(200);
    expect((await api.request('PUT', `${C}/${sol.id}`, { cookie: as.owner, body: { ...unsent, name: 'Dr. Mira Sol', acceptingNewPatients: false } })).statusCode).toBe(200);
    expect((await stored()).providers.find((p) => p.id === sol.id)!.visitTypeIds).toEqual(['vt_sick']);
    // none ticked is refused in a plain sentence: nobody could book them
    const none = await api.request('PUT', `${C}/${sol.id}`, { cookie: as.owner, body: { ...unsent, name: 'Dr. Mira Sol', visitTypeIds: [] } });
    expect(none.statusCode).toBe(422);
    expect(JSON.stringify(none.json().issues)).toContain('choose at least one visit type they do');
    expect((await api.request('DELETE', `${C}/${sol.id}`, { cookie: as.owner })).statusCode).toBe(200);
  });

  it('sends a warning for each visit type nobody does, in the same words Settings shows', async () => {
    const before = await stored();
    expect((await api.request('GET', C, { cookie: as.staff })).json().noProvider).toEqual([]);
    const put = async (config: unknown) => api.t.db.execute(sql`update clinics set config = ${JSON.stringify(config)}::jsonb where id = ${DEMO_CLINIC.id}`);
    await put({ ...before, providers: before.providers.map((p) => ({ ...p, visitTypeIds: p.visitTypeIds.filter((v) => v !== 'vt_new') })) });
    const list = (await api.request('GET', C, { cookie: as.staff })).json();
    expect(list.noProvider).toEqual([{ visitTypeId: 'vt_new', message: 'No doctor does new patient visit: callers can\'t book it' }]);
    expect(list.noProvider).toEqual(noProviderWarnings(await stored()));
    await put(before);
  });

  it('saves how the assistant says a doctor\'s name in another language, and keeps it on the next save', async () => {
    const res = await api.request('PUT', `${C}/${id}`, { cookie: as.owner, body: { ...kim, names: { es: 'el doctor Jae Kim' } } });
    expect(res.statusCode).toBe(200);
    expect((await stored()).providers.find((p) => p.id === id)?.names).toEqual({ es: 'el doctor Jae Kim' });
    // the Doctors page sends back what it loaded, names included
    const loaded = (await stored()).providers.find((p) => p.id === id)!;
    await api.request('PUT', `${C}/${id}`, { cookie: as.owner, body: { ...loaded, specialty: 'Family medicine' } });
    expect((await stored()).providers.find((p) => p.id === id)).toMatchObject({ specialty: 'Family medicine', names: { es: 'el doctor Jae Kim' } });
  });

  it('takes a specialty and categories only from the clinic\'s lists, and keeps what a doctor already has', async () => {
    // not on the list: refused under its field, in a plain sentence
    const typed = await api.request('PUT', `${C}/${id}`, { cookie: as.owner, body: { ...kim, specialty: 'Surgery' } });
    expect(typed.statusCode).toBe(422);
    expect(typed.json().issues).toEqual([{ path: 'specialty', message: '"Surgery" is not on your list. Pick one from the list, or add it to the list first (Settings, Fields and lists).' }]);
    const chip = await api.request('POST', C, { cookie: as.owner, body: { ...kim, name: 'Dr. Ines Vale', categories: ['Children', 'Asthma'] } });
    expect(chip.statusCode).toBe(422);
    expect(chip.json().issues[0].path).toBe('categories');
    // added to the list (the "+ Add a specialty…" choice), then it is taken
    const lists = `/api/v1/clinics/${DEMO_CLINIC.id}/settings/lists/specialties`;
    const before = await stored();
    expect((await api.request('PUT', lists, { cookie: as.owner, body: { values: ['Family medicine', 'Pediatrics', 'Surgery'] } })).statusCode).toBe(200);
    expect((await api.request('PUT', `${C}/${id}`, { cookie: as.owner, body: { ...kim, specialty: 'Surgery' } })).statusCode).toBe(200);
    // a value already on the doctor that has left the list stays when the doctor is saved again: nothing is lost
    await api.t.db.execute(sql`update clinics set config = jsonb_set(config, '{lists,specialties}', '["Family medicine", "Pediatrics"]') where id = ${DEMO_CLINIC.id}`);
    expect((await api.request('PUT', `${C}/${id}`, { cookie: as.owner, body: { ...kim, specialty: 'Surgery', acceptingNewPatients: false } })).statusCode).toBe(200);
    expect((await stored()).providers.find((p) => p.id === id)!.specialty).toBe('Surgery');
    // and put back as it was for the tests below
    await api.t.db.execute(sql`update clinics set config = ${JSON.stringify({ ...before, providers: (await stored()).providers.map((p) => (p.id === id ? { ...p, specialty: 'Pediatrics' } : p)) })}::jsonb where id = ${DEMO_CLINIC.id}`);
  });

  it('refuses a number another doctor at the clinic has, under the field, and keeps the numbers as the clinic dials them', async () => {
    const first = await api.request('POST', C, { cookie: as.owner, body: { ...kim, name: 'Dr. Numbered One', phone: '(303) 555-0181', otherPhones: ['303 555 0182'] } });
    expect(first.statusCode).toBe(201);
    expect(first.json().providers.find((p: { name: string }) => p.name === 'Numbered One')).toMatchObject({ phone: '+13035550181', otherPhones: ['+13035550182'] });
    const same = await api.request('POST', C, { cookie: as.owner, body: { ...kim, name: 'Dr. Numbered Two', phone: '+13035550182' } });
    expect(same.statusCode).toBe(422);
    expect(same.json().issues).toEqual([{ path: 'phone', message: 'Dr. Numbered One already has this number.' }]);
    const other = await api.request('POST', C, { cookie: as.owner, body: { ...kim, name: 'Dr. Numbered Two', phone: '+13035550183', otherPhones: ['3035550181'] } });
    expect(other.json().issues).toEqual([{ path: 'otherPhones', message: 'Dr. Numbered One already has this number.' }]);
    // a doctor at a clinic for people needs no number; the import finds a doctor by their number before their name
    expect((await api.request('POST', C, { cookie: as.owner, body: { ...kim, name: 'Dr. No Number' } })).statusCode).toBe(201);
    const csv = 'name,phone,specialty\nDr. Numbered One (renamed),(303) 555-0181,Pediatrics\nDr. Numbered Three,(303) 555-0182,Pediatrics';
    const dry = (await api.request('POST', `${C}/import`, { cookie: as.admin, body: { csv, dryRun: true } })).json();
    expect(dry.rows.map((r: { status: string; message: string | null }) => [r.status, r.message])).toEqual([['update', null], ['error', 'Dr. Numbered One is already on another row of the file (the same number or name)']]);
    const taken = (await api.request('POST', `${C}/import`, { cookie: as.admin, body: { csv: 'name,phone,specialty\nDr. Numbered Three,(303) 555-0182,Pediatrics', dryRun: true } })).json();
    expect(taken.rows[0]).toMatchObject({ status: 'update', name: 'Dr. Numbered Three' }); // the number is the doctor: their row, renamed (as the file typed it)
  });

  it('lets the stand-in a new clinic starts with go once a real doctor is added, unless a visit points at it', async () => {
    const before = await stored();
    const standIn = { id: 'prov_1', name: 'our doctor', visitTypeIds: ['vt_sick'], placeholder: true, categories: [], acceptingNewPatients: true, timeOff: [] };
    const put = async (config: unknown) => api.t.db.execute(sql`update clinics set config = ${JSON.stringify(config)}::jsonb where id = ${DEMO_CLINIC.id}`);
    await put({ ...before, providers: [...before.providers, standIn] });
    const added = await api.request('POST', C, { cookie: as.owner, body: { ...kim, name: 'Dr. Ines Vale' } });
    expect(added.statusCode).toBe(201);
    expect((await stored()).providers.some((p) => p.id === 'prov_1')).toBe(false);
    // with a visit on file, it stays in the settings, and the dashboard and the assistant pass it by
    await put({ ...(await stored()), providers: [...(await stored()).providers, standIn] });
    await api.t.db.execute(sql`insert into appointments (clinic_id, patient_id, provider_id, visit_type_id, starts_at, ends_at, idempotency_key, created_by_user_id)
      values (${DEMO_CLINIC.id}, ${api.patientIds.maria}, 'prov_1', 'vt_sick', '2026-09-01T15:00:00Z', '2026-09-01T15:20:00Z', 'doctors-test-stand-in', ${api.users.owner})`);
    const vale = (await stored()).providers.find((p) => p.name === 'Ines Vale')!;
    expect((await api.request('PUT', `${C}/${vale.id}`, { cookie: as.owner, body: { ...kim, name: 'Dr. Ines Vale', acceptingNewPatients: false } })).statusCode).toBe(200);
    expect((await stored()).providers.some((p) => p.id === 'prov_1')).toBe(true);
    await api.t.db.execute(sql`delete from appointments where provider_id = 'prov_1'`);
    await put({ ...before, providers: before.providers });
  });

  it('keeps doctors when Settings is saved from a page opened before they were added', async () => {
    const before = await stored();
    const old = { ...before, providers: before.providers.filter((p) => p.id !== id) };
    expect((await api.request('PUT', `/api/v1/clinics/${DEMO_CLINIC.id}/settings`, { cookie: as.owner, body: old })).statusCode).toBe(200);
    expect((await stored()).providers.some((p) => p.id === id)).toBe(true);
  });

  it('saves the order of the doctors from Settings (Booking rules), keeping any it was not sent at the end', async () => {
    const before = await stored();
    const reversed = [...before.providers].reverse();
    expect((await api.request('PUT', `/api/v1/clinics/${DEMO_CLINIC.id}/settings`, { cookie: as.owner, body: { ...before, providers: reversed.slice(1) } })).statusCode).toBe(200);
    const after = (await stored()).providers.map((p) => p.id);
    expect(after).toEqual([...reversed.slice(1).map((p) => p.id), reversed[0]!.id]);
  });

  it('will not remove a doctor with visits to come', async () => {
    const at = zonedInstant('2026-09-29', '09:00', DEMO_CLINIC.timezone).toISOString();
    const booking = await api.request('POST', `/api/v1/clinics/${DEMO_CLINIC.id}/appointments`, {
      cookie: as.staff, body: { patientId: api.patientIds.maria, providerId: 'prov_okafor', visitTypeId: 'vt_sick', startsAt: at, idempotencyKey: 'doctors-test-1' },
    });
    expect(booking.statusCode).toBe(201);
    const refused = await api.request('DELETE', `${C}/prov_okafor`, { cookie: as.owner });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/1 booked visit still to come/);
    expect((await api.request('DELETE', `${C}/${id}`, { cookie: as.owner })).statusCode).toBe(200);
    expect((await stored()).providers.some((p) => p.id === id)).toBe(false);
  });

  it('removes the right one of two vets with the same name, and says why one with visits to come stays', async () => {
    const add = async (phone: string) => (await api.request('POST', C, { cookie: as.owner, body: { ...kim, name: 'John Doe', phone } })).json().providers
      .find((p: { name: string; phone?: string }) => p.name === 'John Doe' && p.phone === phone).id as string;
    const one = await add('+13035550141');
    const two = await add('+13035550142');
    expect(one).not.toBe(two);
    const at = zonedInstant('2026-10-05', '09:00', DEMO_CLINIC.timezone).toISOString();
    const booking = await api.request('POST', `/api/v1/clinics/${DEMO_CLINIC.id}/appointments`, {
      cookie: as.staff, body: { patientId: api.patientIds.maria, providerId: one, visitTypeId: 'vt_sick', startsAt: at, idempotencyKey: 'doctors-test-john-doe' },
    });
    expect(booking.statusCode, booking.body).toBe(201);
    // the hosted setup page labels its DELETE as JSON with no body: that once failed with a 400 and no words
    const json = { 'content-type': 'application/json' };
    const refused = await api.request('DELETE', `${C}/${one}`, { cookie: as.owner, headers: json });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'has_upcoming_visits', message: 'They have 1 booked visit still to come. Move or cancel it on the Schedule first.' });
    const res = await api.request('DELETE', `${C}/${two}`, { cookie: as.owner, headers: json });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored()).providers.filter((p) => p.name === 'John Doe').map((p) => p.id)).toEqual([one]);
  });

  it('imports doctors from a CSV: checks first, then adds new ones and updates the ones on file', async () => {
    const csv = [
      'id,name,gender,specialty,categories,ages_min,ages_max,accepting_new_patients,visit_types,mon,tue,wed,thu,fri,sat,sun,time_off',
      ',Dr. Lee Park,female,Dermatology,Skin; Allergies,,,yes,sick visit,08:00-12:00,,,,,,,2026-11-27',
      ',Dr. Nkem Okafor,,Family medicine,Adults; Diabetes,,,yes,sick visit; annual physical; new patient visit,,,,,,,,',
      ',Dr. Broken,,,,,,maybe,,,,,,,,,',
      ',Dr. Hours,,,,,,,,9-5,,,,,,,',
    ].join('\n');
    const dry = (await api.request('POST', `${C}/import`, { cookie: as.admin, body: { csv, dryRun: true } })).json();
    expect(dry.rows.map((r: { status: string }) => r.status)).toEqual(['add', 'update', 'error', 'error']);
    // what a row adds to the clinic's lists is said before anything is imported: the manager's OK
    expect(dry.rows[0].message).toBe('adds "Dermatology", "Skin", "Allergies" to your lists');
    expect((await stored()).providers.some((p) => p.name === 'Lee Park')).toBe(false);
    const real = (await api.request('POST', `${C}/import`, { cookie: as.admin, body: { csv, dryRun: false } })).json();
    expect(real.counts).toEqual({ add: 1, update: 1, skip: 0, error: 2, notListed: 0 });
    const after = await stored();
    expect(after.providers.find((p) => p.name === 'Lee Park')).toMatchObject({ gender: 'female', specialty: 'Dermatology', timeOff: [{ from: '2026-11-27', to: '2026-11-27' }] });
    expect(after.providers.find((p) => p.id === 'prov_okafor')!.gender).toBe('male'); // an empty cell keeps what is on file
    expect(after.providers.find((p) => p.id === 'prov_okafor')!.categories).toEqual(['Adults', 'Diabetes']);
    expect((await api.request('POST', `${C}/import`, { cookie: as.staff, body: { csv, dryRun: true } })).statusCode).toBe(403);
  });

  it('imports a doctor whose specialty finds no room on a full list, and says so on the row and in the counts', async () => {
    const lists = `/api/v1/clinics/${DEMO_CLINIC.id}/settings/lists/specialties`;
    const sixty = Array.from({ length: 60 }, (_, i) => `Specialty ${i + 1}`);
    expect((await api.request('PUT', lists, { cookie: as.owner, body: { values: sixty } })).statusCode).toBe(200);
    const csv = [
      'id,name,gender,specialty,categories',
      ',Dr. Ines Vallejo,female,Specialty 7,',
      ',Dr. Tomas Lindqvist,male,Oncology,Adults',
    ].join('\n');
    const dry = (await api.request('POST', `${C}/import`, { cookie: as.admin, body: { csv, dryRun: true } })).json();
    expect(dry.rows.map((r: { status: string; message: string | null }) => [r.status, r.message])).toEqual([
      ['add', null],
      ['add', '"Oncology" not added to your list: it already has 60 values; remove one in Settings, Fields and lists'],
    ]);
    expect(dry.counts).toEqual({ add: 2, update: 0, skip: 0, error: 0, notListed: 1 });
    const real = (await api.request('POST', `${C}/import`, { cookie: as.admin, body: { csv, dryRun: false } })).json();
    expect(real.counts).toEqual({ add: 2, update: 0, skip: 0, error: 0, notListed: 1 });
    const after = await stored();
    expect(after.providers.find((p) => p.name === 'Tomas Lindqvist')).toMatchObject({ specialty: 'Oncology', categories: ['Adults'] });
    expect(after.lists?.specialties).toEqual(sixty);
  });
});

describe('changes as they happen', () => {
  it('tells a signed-in browser which kinds of thing changed, and nothing else', async () => {
    await api.app.listen(0, '127.0.0.1');
    const address = (await api.app.getUrl()).replace('[::1]', '127.0.0.1');
    const abort = new AbortController();
    const res = await fetch(`${address}/api/v1/clinics/${DEMO_CLINIC.id}/changes`, { headers: { cookie: as.staff }, signal: abort.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const read = async () => { let text = ''; while (!text.includes('event: change')) text += new TextDecoder().decode((await reader.read()).value); return text; };
    const next = read();
    await api.request('POST', `/api/v1/clinics/${DEMO_CLINIC.id}/tasks/${api.taskId}/notes`, { cookie: as.staff, body: { body: 'called the pharmacy' } });
    const text = await next;
    expect(text).toMatch(/event: change\ndata: \{"topics":\["requests"\]\}/);
    expect(text).not.toMatch(/pharmacy|maria/i);
    abort.abort();
  });
});
