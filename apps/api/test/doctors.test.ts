import { ClinicConfig, DEMO_CLINIC, zonedInstant } from '@attendra/core';
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

  it('everyone on the team can see them; only managers change them', async () => {
    for (const role of ['owner', 'admin', 'staff', 'viewer'] as const) expect((await api.request('GET', C, { cookie: as[role] })).statusCode, role).toBe(200);
    expect((await api.request('POST', C, { cookie: as.staff, body: kim })).statusCode).toBe(403);
  });

  it('adds a doctor with a specialty, the ages they see, weekly hours and days off, under a new id', async () => {
    const res = await api.request('POST', C, { cookie: as.admin, body: kim });
    expect(res.statusCode).toBe(201);
    const added = res.json().providers.find((p: { name: string }) => p.name === kim.name);
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
    const vale = (await stored()).providers.find((p) => p.name === 'Dr. Ines Vale')!;
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
    expect((await stored()).providers.some((p) => p.name === 'Dr. Lee Park')).toBe(false);
    const real = (await api.request('POST', `${C}/import`, { cookie: as.admin, body: { csv, dryRun: false } })).json();
    expect(real.counts).toEqual({ add: 1, update: 1, skip: 0, error: 2 });
    const after = await stored();
    expect(after.providers.find((p) => p.name === 'Dr. Lee Park')).toMatchObject({ gender: 'female', specialty: 'Dermatology', timeOff: [{ from: '2026-11-27', to: '2026-11-27' }] });
    expect(after.providers.find((p) => p.id === 'prov_okafor')!.gender).toBe('male'); // an empty cell keeps what is on file
    expect(after.providers.find((p) => p.id === 'prov_okafor')!.categories).toEqual(['Adults', 'Diabetes']);
    expect((await api.request('POST', `${C}/import`, { cookie: as.staff, body: { csv, dryRun: true } })).statusCode).toBe(403);
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
