import { PACKS, RIVERBEND_CLINIC, zonedInstant } from '@attendra/core';
import { PostgresPatientDirectory, createPhiCipher, seedRiverbend } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CallState, ResponsesPlanner } from '../src';
import { world } from './support';

/**
 * What the assistant may say about an owner's pets and their visits, by how much it knows (2026-11):
 * the number alone gives no pet; caller ID and the owner's name give their pets' first names to pick
 * from; a found pet gives its last and next visits and its usual vet; nothing medical, ever.
 */
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const LINH = '+17205550172';
const handed = (out: { results: { data: Record<string, unknown> }[] }) => JSON.stringify(out.results.map((r) => r.data));
const audited = async (action: string, callId: string) => Number((await w.t.db.execute(sql`select count(*)::int as n from audit_logs where action = ${action} and call_id = ${callId}`)).rows[0]!.n);
const directory = () => new PostgresPatientDirectory(w.t.db, createPhiCipher(TEST_DATA_KEY), 'seed');

describe('an owner caller ID knows picks from their pets', () => {
  it('names the owner\'s pets on this number, with real caller ID and the owner\'s name on file, and audits it', async () => {
    const c = await w.call(LINH, { clinic });
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: null } }]);
    expect(out.results[0]!.data).toMatchObject({ verified: false, pets_on_number: ['Biscuit', 'Mochi'], more: false });
    expect(String(out.results[0]!.data.say)).toContain('"Is this for Biscuit or Mochi, or a new pet?"');
    expect(c.state.verifiedPatient).toBeNull();
    expect(await audited('patient.pets_on_number.read', c.callId)).toBe(1);
    // picking one finds it, as any lookup does
    const picked = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Mochi', phone: null } }]);
    expect(picked.results[0]!.data).toMatchObject({ verified: true, pet_name: 'Mochi' });
  });

  it('asks in Spanish on a Spanish call', async () => {
    const c = await w.call(LINH, { clinic });
    c.caller('Hola, buenos días, soy Linh. Quiero una cita, por favor.');
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: null } }]);
    expect(String(out.results[0]!.data.say)).toContain('"¿Es para Biscuit o Mochi, o para una mascota nueva?"');
  });

  it('never names a pet without caller ID: a hidden number, a browser test call, or a number the caller only says', async () => {
    for (const [number, opts, phone] of [
      [null, {}, null], [null, { channel: 'web' as const }, LINH], [LINH, { channel: 'web' as const }, null], [LINH, {}, '720 555 0173'],
    ] as const) {
      const c = await w.call(number, { clinic, ...opts });
      const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: null, phone } }]);
      expect(out.errors).toEqual(['pet_name']);
      expect(handed(out)).not.toMatch(/biscuit|mochi/i);
      expect(await audited('patient.pets_on_number.read', c.callId)).toBe(0);
    }
  });

  it('on a family number names only the confirmed owner\'s pets, and a name that matches nobody uses a try', async () => {
    await directory().create(clinic.id, { firstName: 'Juniper', lastName: 'Hale', dob: '2022-04-01', phone: LINH, guardianName: 'Grace Hale', gender: 'female', species: 'cat' });
    const grace = await w.call(LINH, { clinic });
    const hers = await grace.delegate([{ tool: 'verify_caller', args: { owner_name: 'Grace', pet_name: null } }]);
    expect(hers.results[0]!.data.pets_on_number).toEqual(['Juniper']);
    expect(handed(hers)).not.toMatch(/biscuit|mochi/i);
    const linh = await w.call(LINH, { clinic });
    expect((await linh.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: null } }])).results[0]!.data.pets_on_number).toEqual(['Biscuit', 'Mochi']);
    const stranger = await w.call(LINH, { clinic });
    const out = await stranger.delegate([{ tool: 'verify_caller', args: { owner_name: 'Ana', pet_name: null } }]);
    expect(out.errors).toEqual(['pet_name']);
    expect(handed(out)).not.toMatch(/biscuit|mochi|juniper/i);
    expect(stranger.state.verifyAttempts).toBe(1);
  });

  it('names at most three, then "or another one"', async () => {
    const many = '+17205550186';
    for (const name of ['Ash', 'Bean', 'Coco', 'Dot', 'Echo']) {
      await directory().create(clinic.id, { firstName: name, lastName: 'Moss', dob: '2020-01-01', phone: many, guardianName: 'Ivy Moss', gender: 'female', species: 'dog' });
    }
    const c = await w.call(many, { clinic });
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Ivy', pet_name: null } }]);
    expect(out.results[0]!.data).toMatchObject({ pets_on_number: ['Ash', 'Bean', 'Coco'], more: true });
    expect(String(out.results[0]!.data.say)).toContain(PACKS.en.whichPet({ names: ['Ash', 'Bean', 'Coco'], more: true }));
    expect(PACKS.en.whichPet({ names: ['Ash', 'Bean', 'Coco'], more: true })).toBe('Is this for Ash, Bean or Coco, or another one?');
    expect(handed(out)).not.toMatch(/dot|echo/i);
  });
});

describe('the answer to "Is this for Biscuit or Mochi, or a new pet?"', () => {
  const answer = (question: string, said: string) => {
    const s = new CallState();
    s.addTranscript('agent', question, 0, 900);
    s.addTranscript('caller', said, 1000, 1500);
    return s.saidNew();
  };
  it.each([
    ['a yes picks the pet named', 'Is this for Juniper, or a new pet?', 'Yes, for Juniper.', '¿Es para Juniper, o para una mascota nueva?', 'Sí, para Juniper.', null],
    ['naming one picks it', 'Is this for Biscuit or Mochi, or a new pet?', "It's for Mochi.", '¿Es para Biscuit o Mochi, o para una mascota nueva?', 'Es para Mochi.', null],
    ['"a new one" is new', 'Is this for Biscuit or Mochi, or a new pet?', 'A new one.', '¿Es para Biscuit o Mochi, o para una mascota nueva?', 'Una nueva.', 'new'],
    ['"another one" of theirs is not new', 'Is this for Ash, Bean or Coco, or another one?', 'Yes, another one, Dot.', '¿Es para Ash, Bean o Coco, o para otra mascota?', 'Sí, otra, Dot.', null],
    ['a yes to "is it new?" is still new', 'Is Orbit new to the clinic?', 'Yes.', '¿Orbit es nueva en la clínica?', 'Sí.', 'new'],
  ] as const)('%s, in English and Spanish', (_b, q, said, qEs, saidEs, expected) => {
    expect(answer(q, said)).toBe(expected);
    expect(answer(qEs, saidEs)).toBe(expected);
  });
});

describe('a found pet\'s visits: the last and the next, and the usual vet, never anything medical', () => {
  const at = (date: string, time: string) => zonedInstant(date, time, clinic.timezone);
  const book = async (patientId: string, providerId: string, visitTypeId: string, start: Date, key: string) => {
    const r = await w.backend.scheduler.book(clinic.id, { patientId, callId: (await w.call(null, { clinic })).callId, idempotencyKey: key,
      slot: { id: key, providerId, visitTypeId, start, end: new Date(start.getTime() + 30 * 60_000) } });
    if (r.status !== 'booked') throw new Error(`setup booking ${key}: ${r.status}`);
    return r.appointment.id;
  };

  it('is refused before the pet is found, whatever the caller ID knows', async () => {
    const c = await w.call(LINH, { clinic, history: 'Name on file for this number: Linh.' });
    const out = await c.delegate([{ tool: 'visit_summary', args: {} }]);
    expect(out.errors).toEqual(['not_verified']);
    expect(handed(out)).not.toMatch(/biscuit|ruiz|wellness/i);
  });

  it('gives only that pet\'s next visits, its last visit that took place, and its usual vet, said as "the last visit I can see", and audits it', async () => {
    const [biscuit, mochi] = [w.patientIds.biscuit!, w.patientIds.mochi!];
    const [ruiz, other] = [clinic.providers[0]!.id, clinic.providers[1]!.id];
    const vt = clinic.visitTypes[0]!.id;
    await book(biscuit, ruiz, vt, at('2026-08-10', '10:00'), 'past-1');
    await book(biscuit, ruiz, vt, at('2026-09-14', '09:00'), 'past-2');
    const cancelled = await book(biscuit, other, vt, at('2026-09-21', '09:00'), 'past-cancelled');
    await w.backend.scheduler.cancel(clinic.id, { patientId: biscuit, appointmentId: cancelled, callId: (await w.call(null, { clinic })).callId, idempotencyKey: 'cancel-it' });
    await book(mochi, other, vt, at('2026-09-25', '09:00'), 'mochi-past');
    await book(biscuit, other, vt, at('2026-10-06', '15:00'), 'next-1');

    const c = await w.call(LINH, { clinic });
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit', phone: null } }]);
    const out = await c.delegate([{ tool: 'visit_summary', args: {} }]);
    const data = out.results[0]!.data;
    const name = (id: string) => clinic.providers.find((p) => p.id === id)!.name;
    expect(Object.keys(data).sort()).toEqual(['last_visit', 'next_visits', 'pet', 'say', 'usual_vet']);
    expect(data.last_visit).toEqual({ when: PACKS.en.speakWhen(at('2026-09-14', '09:00'), clinic.timezone), vet: name(ruiz), visit: clinic.visitTypes[0]!.name });
    expect(data.next_visits).toEqual([{ when: PACKS.en.speakWhen(at('2026-10-06', '15:00'), clinic.timezone), vet: name(other), visit: clinic.visitTypes[0]!.name }]);
    expect(data.usual_vet).toBe(name(ruiz));
    expect(String(data.say)).toContain(`"The last visit I can see for Biscuit was on ${PACKS.en.speakWhen(at('2026-09-14', '09:00'), clinic.timezone)}`);
    expect(String(data.say)).toContain(PACKS.en.recordsOffer);
    // only what is listed: no ids, notes, reasons or anything medical in the facts (the instruction names what never to say)
    expect(JSON.stringify({ ...data, say: undefined })).not.toMatch(/appointment_id|note|reason|diagnos|weight|invoice|result/i);
    expect(await audited('patient.visits.read.call', c.callId)).toBe(1);
  });

  it('says it can\'t see an earlier visit, never that there was none', async () => {
    const c = await w.call('+17205550173', { clinic });
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Daniel', pet_name: 'Pepper', phone: null } }]);
    const data = (await c.delegate([{ tool: 'visit_summary', args: {} }])).results[0]!.data;
    expect(data).toMatchObject({ last_visit: null, usual_vet: null, next_visits: [] });
    expect(String(data.say)).toContain('can\'t see one, never that there was none');
  });

  it('is offered only at a veterinary clinic', async () => {
    const toolsFor = async (c: typeof RIVERBEND_CLINIC) => {
      const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'ok' }));
      await new ResponsesPlanner({ responses: { create } } as never, 'test-model').plan({ clinic: c, state: new CallState(), nowLine: 'Today is Monday.' }, async () => ({ ok: true, data: {} }));
      return (create.mock.calls[0]![0] as { tools: { name: string }[] }).tools.map((t) => t.name);
    };
    expect(await toolsFor(RIVERBEND_CLINIC)).toContain('visit_summary');
    const { DEMO_CLINIC } = await import('@attendra/core');
    expect(await toolsFor(DEMO_CLINIC)).not.toContain('visit_summary');
  });
});

describe('unchanged: what the number alone gives', () => {
  it('still asks "Am I speaking with ...?", gives only when and how often the number called and whether a request is open, never a pet', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Done.' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-test');
    const c = await w.call(LINH, { clinic, history: 'Name on file for this number: Linh.\nCalls from this number in the last 30 days: 2.' });
    await c.delegate([], planner);
    const input = JSON.stringify((create.mock.calls[0]![0] as { input: unknown }).input);
    expect(input).toContain('Am I speaking with <that name>?');
    expect(input).toContain('¿Hablo con <that name>?');
    expect(input).toContain('from the number alone you may say only how many times and when this number called');
    expect(input).toContain('whether a request from those calls is still open with the team');
    expect(input).toContain('never what it was about');
    expect(input).toContain('a pet\'s name comes only from there, never from these records');
    expect(input).not.toMatch(/biscuit|mochi/i);
  });
});
