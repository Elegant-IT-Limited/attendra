import { ClinicConfig, DEMO_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
let api: Awaited<ReturnType<typeof startApi>>;
let admin: string;
let staff: string;

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  admin = await api.signIn('olga@maple.example', true);
  staff = await api.signIn('ana@maple.example', true);
});
afterAll(() => api.close());

const settings = async () => ClinicConfig.parse((await api.request('GET', `${C}/settings`, { cookie: admin })).json());
const saveFields = async (patch: Partial<ClinicConfig>) => {
  const res = await api.request('PUT', `${C}/settings`, { cookie: admin, body: { ...(await settings()), ...patch } });
  expect(res.statusCode).toBe(200);
};

describe('fields and lists of the clinic\'s own', () => {
  it('saves a list in order and carries a rename and a removal to every doctor, audited', async () => {
    const before = await settings();
    const specialty = before.providers.find((p) => p.specialty)!.specialty!;
    const others = [...new Set(before.providers.map((p) => p.specialty).filter((s): s is string => !!s && s !== specialty))];
    const res = await api.request('PUT', `${C}/settings/lists/specialties`, { cookie: admin, body: { values: [`${specialty} (renamed)`, ...others], renamed: { [specialty]: `${specialty} (renamed)` } } });
    expect(res.statusCode).toBe(200);
    const after = await settings();
    expect(after.lists?.specialties?.[0]).toBe(`${specialty} (renamed)`);
    expect(after.providers.some((p) => p.specialty === specialty)).toBe(false);
    expect(after.providers.some((p) => p.specialty === `${specialty} (renamed)`)).toBe(true);
    expect((await api.request('PUT', `${C}/settings/lists/nonsense`, { cookie: admin, body: { values: [] } })).statusCode).toBe(404);
    expect((await api.request('PUT', `${C}/settings/lists/specialties`, { cookie: staff, body: { values: [] } })).statusCode).toBe(403);
    expect((await api.request('PUT', `${C}/settings/lists/species`, { cookie: admin, body: { values: ['Dog', 'dog'] } })).statusCode).toBe(422);
  });

  it('keeps a doctor\'s own details, and asks for a required one', async () => {
    await saveFields({ providerFields: [{ id: 'licence', label: 'Licence', kind: 'text', required: true }, { id: 'home', label: 'Home phone', kind: 'text', tellCallers: false }] });
    // a field the clinic keeps for its team stays so; one saved without the switch is told to callers
    expect((await settings()).providerFields?.map((f) => f.tellCallers)).toEqual([undefined, false]);
    const doc = (await settings()).providers[0]!;
    const rest = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'id'));
    const missing = await api.request('PUT', `${C}/doctors/${doc.id}`, { cookie: admin, body: { ...rest, gender: doc.gender ?? 'female', custom: { licence: '' } } });
    expect(missing.statusCode).toBe(422);
    const ok = await api.request('PUT', `${C}/doctors/${doc.id}`, { cookie: admin, body: { ...rest, gender: doc.gender ?? 'female', custom: { licence: 'CO-12345' } } });
    expect(ok.statusCode).toBe(200);
    expect((await settings()).providers[0]!.custom).toEqual({ licence: 'CO-12345' });
    // a form that sends no details keeps them
    expect((await api.request('PUT', `${C}/doctors/${doc.id}`, { cookie: admin, body: { ...rest, gender: doc.gender ?? 'female' } })).statusCode).toBe(200);
    expect((await settings()).providers[0]!.custom).toEqual({ licence: 'CO-12345' });
  });

  it('keeps a request\'s own details, encrypted, and shows them on the card', async () => {
    await saveFields({ requestFields: [{ id: 'pharmacy', label: 'Pharmacy', kind: 'choice', options: ['Walgreens', 'CVS'] }] });
    expect((await api.request('PUT', `${C}/tasks/${api.taskId}/fields`, { cookie: staff, body: { values: { pharmacy: 'Rite Aid' } } })).statusCode).toBe(422);
    expect((await api.request('PUT', `${C}/tasks/${api.taskId}/fields`, { cookie: staff, body: { values: { pharmacy: 'cvs' } } })).statusCode).toBe(204);
    const tasks = (await api.request('GET', `${C}/tasks`, { cookie: staff })).json().tasks as { id: string; custom: Record<string, string> }[];
    expect(tasks.find((t) => t.id === api.taskId)?.custom).toEqual({ pharmacy: 'CVS' });
    const raw = await api.t.db.execute(`select custom_enc from tasks where id = '${api.taskId}'`);
    expect(JSON.stringify(raw.rows)).not.toContain('CVS');
  });

  it('filters patients by one of the clinic\'s fields, read on the server', async () => {
    await saveFields({ customFields: [{ id: 'insured', label: 'Insured', kind: 'yesno' }] });
    expect((await api.request('PUT', `${C}/patients/${api.patientIds.maria}/fields`, { cookie: staff, body: { values: { insured: 'yes' } } })).statusCode).toBe(204);
    const yes = (await api.request('POST', `${C}/patients/filter`, { cookie: staff, body: { field: { id: 'insured', value: 'yes' } } })).json();
    expect(yes.patients.map((p: { id: string }) => p.id)).toEqual([api.patientIds.maria]);
    expect(yes.patients[0].custom).toEqual({ insured: 'yes' });
    expect((await api.request('POST', `${C}/patients/filter`, { cookie: staff, body: { field: { id: 'nope', value: 'yes' } } })).statusCode).toBe(422);
  });
});
