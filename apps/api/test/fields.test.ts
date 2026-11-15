import { ClinicConfig, DEMO_CLINIC } from '@attendra/core';
import { createPhiCipher, PostgresTaskQueue } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
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
    const raw = await api.t.owner.execute(`select custom_enc from tasks where id = '${api.taskId}'`);
    expect(JSON.stringify(raw.rows)).not.toContain('CVS');
  });

  // note 2026-11-16 F1: a renamed dropdown choice stayed under its old name on every record, so the record's Details
  // showed "Not filled in" and saving them erased it. Renamed on the page, it is renamed on every record that has it
  it('carries a renamed dropdown choice to every pet or patient, request and doctor; a removed one stays as it was', async () => {
    const before = await settings();
    const fields = (insurer: string[], wing: string[], badge: string[]) => ({
      customFields: [{ id: 'insurer', label: 'Pet insurance', kind: 'choice' as const, options: insurer }, { id: 'extras', label: 'Extras', kind: 'multi' as const, options: ['Nail trim', 'Bath'] }],
      requestFields: [{ id: 'wing', label: 'Boarding wing', kind: 'choice' as const, options: wing }],
      providerFields: [{ id: 'badge', label: 'Badge colour', kind: 'choice' as const, options: badge }],
      requestTopics: before.requestTopics ?? [],
    });
    const put = (body: unknown, cookie = admin) => api.request('PUT', `${C}/settings/fields`, { cookie, body });
    expect((await put(fields(['Acme Pet Cover', 'Northwind Pet Plan'], ['North wing', 'South wing'], ['Blue', 'Green']))).statusCode).toBe(200);
    const maria = api.patientIds.maria;
    expect((await api.request('PUT', `${C}/patients/${maria}/fields`, { cookie: staff, body: { values: { insurer: 'Acme Pet Cover', extras: 'Nail trim | Bath' } } })).statusCode).toBe(204);
    expect((await api.request('PUT', `${C}/tasks/${api.taskId}/fields`, { cookie: staff, body: { values: { wing: 'South wing' } } })).statusCode).toBe(204);
    const doc = (await settings()).providers[0]!;
    const rest = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'id'));
    expect((await api.request('PUT', `${C}/doctors/${doc.id}`, { cookie: admin, body: { ...rest, gender: doc.gender ?? 'female', custom: { badge: 'Green' } } })).statusCode).toBe(200);

    // a viewer of settings cannot, and the new name must be one of the choices
    expect((await put({ ...fields(['Acme Pet Cover Plus', 'Northwind Pet Plan'], ['North wing', 'South wing'], ['Blue', 'Green']), renamed: {} }, staff)).statusCode).toBe(403);
    // renamed: the insurer and a multi-choice; the wing renamed; the badge colour renamed; Northwind removed
    const res = await put({
      ...fields(['Acme Pet Cover Plus', 'Riverside Mutual'], ['North wing', 'South wing (kennels)'], ['Blue', 'Forest green']),
      customFields: [{ id: 'insurer', label: 'Pet insurance', kind: 'choice', options: ['Acme Pet Cover Plus', 'Riverside Mutual'] }, { id: 'extras', label: 'Extras', kind: 'multi', options: ['Nail trim', 'Bath and brush'] }],
      renamed: { customFields: { insurer: { 'Acme Pet Cover': 'Acme Pet Cover Plus' }, extras: { Bath: 'Bath and brush' } }, requestFields: { wing: { 'South wing': 'South wing (kennels)' } }, providerFields: { badge: { Green: 'Forest green' } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().customFields[0].options).toEqual(['Acme Pet Cover Plus', 'Riverside Mutual']);
    const pet = (await api.request('GET', `${C}/patients/${maria}`, { cookie: staff })).json();
    expect(pet.customFields).toEqual({ insurer: 'Acme Pet Cover Plus', extras: 'Nail trim | Bath and brush' });
    const tasks = (await api.request('GET', `${C}/tasks`, { cookie: staff })).json().tasks as { id: string; custom: Record<string, string> }[];
    expect(tasks.find((t) => t.id === api.taskId)?.custom).toEqual({ wing: 'South wing (kennels)' });
    expect((await settings()).providers.find((p) => p.id === doc.id)?.custom?.badge).toBe('Forest green');
    // still encrypted at rest
    expect(JSON.stringify((await api.t.owner.execute(`select custom_enc from patients where id = '${maria}'`)).rows)).not.toContain('Acme');

    // removing a choice is not renaming it: the record keeps what it had, as before
    expect((await api.request('PUT', `${C}/patients/${maria}/fields`, { cookie: staff, body: { values: { insurer: 'Riverside Mutual' } } })).statusCode).toBe(204);
    expect((await put({ ...fields(['Acme Pet Cover Plus', 'Lakeside Pet Plan'], ['North wing', 'South wing (kennels)'], ['Blue', 'Forest green']), renamed: {} })).statusCode).toBe(200);
    expect((await api.request('GET', `${C}/patients/${maria}`, { cookie: staff })).json().customFields).toEqual({ insurer: 'Riverside Mutual' });
    // a rename to a choice the field does not list is not carried
    expect((await put({ ...fields(['Acme Pet Cover Plus', 'Lakeside Pet Plan'], ['North wing', 'South wing (kennels)'], ['Blue', 'Forest green']), renamed: { customFields: { insurer: { 'Riverside Mutual': 'Not listed' } } } })).statusCode).toBe(200);
    expect((await api.request('GET', `${C}/patients/${maria}`, { cookie: staff })).json().customFields).toEqual({ insurer: 'Riverside Mutual' });
    // a field the schema refuses is refused here too
    expect((await put({ ...fields(['Only one'], ['North wing', 'South wing'], ['Blue', 'Green']), renamed: {} })).statusCode).toBe(422);
    const audit = (await api.t.owner.execute(`select count(*)::int as n from audit_logs where action = 'clinic.fields.updated'`)).rows as { n: number }[];
    expect(audit[0]!.n).toBeGreaterThanOrEqual(3);
    await saveFields({ customFields: before.customFields, requestFields: before.requestFields, providerFields: before.providerFields });
  });

  // note 2026-11-16 R2: the call page labelled a request of the clinic's own kind "Callback": it gets the kind's name
  it('names a call\'s request of one of the clinic\'s own kinds on the call page, and a built-in one by its type', async () => {
    await new PostgresTaskQueue(api.t.db, createPhiCipher(TEST_DATA_KEY)).create(DEMO_CLINIC.id, {
      type: 'callback', callId: api.callId, patientId: null, idempotencyKey: 'own-kind-on-call', details: { topic: 'Insurance question', reason: 'A claim form' },
    });
    const call = (await api.request('GET', `${C}/calls/${api.callId}`, { cookie: staff })).json() as { tasks: { type: string; kind: string | null }[] };
    expect(call.tasks.map((t) => [t.type, t.kind])).toEqual(expect.arrayContaining([['refill', null], ['callback', 'Insurance question']]));
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
