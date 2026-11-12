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
const audited = async (action: string, callId: string) => Number((await w.t.owner.execute(sql`select count(*)::int as n from audit_logs where action = ${action} and call_id = ${callId}`)).rows[0]!.n);
const directory = () => new PostgresPatientDirectory(w.t.db, createPhiCipher(TEST_DATA_KEY), 'seed');

describe('an owner caller ID knows picks from their pets', () => {
  it('names the owner\'s pets on this number, with real caller ID and the owner\'s name on file, and audits it', async () => {
    const c = await w.call(LINH, { clinic });
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: null } }]);
    expect(out.results[0]!.data).toMatchObject({ verified: false, pets_on_number: ['Biscuit', 'Mochi'], more: false });
    // caller ID is enough: thanked by the owner's name on file, never asked for it (2026-11-14)
    expect(String(out.results[0]!.data.say)).toContain('"Thanks, Linh. Is this for Biscuit or Mochi, or a new pet?"');
    expect(c.state.verifiedPatient).toBeNull();
    expect(c.state.memory.verified).toBe('caller_id');
    expect(await audited('patient.household.read.call', c.callId)).toBe(1);
    // picking one finds it, as any lookup does
    const picked = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Mochi', phone: null } }]);
    expect(picked.results[0]!.data).toMatchObject({ verified: true, pet_name: 'Mochi' });
  });

  it('a number the caller SAYS, with a name that is not the owner\'s or no name at all, never names the pets on it (FINAL rule, 2026-11-09)', async () => {
    for (const lang of ['en', 'es'] as const) {
      // a wrong name: the check says no match, and the pick question is never asked
      const wrong = await w.call(null, { clinic, channel: 'web' });
      if (lang === 'es') wrong.caller('Hola, soy Jordan. Quiero una cita, por favor.');
      wrong.caller(lang === 'es' ? 'Es el 720 555 0172.' : 'It is 720 555 0172.');
      const readBack = await wrong.delegate([{ tool: 'verify_caller', args: { owner_name: 'Jordan Lee', pet_name: null, phone: '720 555 0172' } }]);
      expect(readBack.errors).toEqual(['confirm_number']);
      wrong.assistant(lang === 'es' ? '¿Es el 720-555-0172?' : "That's 720-555-0172?");
      wrong.caller(lang === 'es' ? 'Sí.' : 'Yes.');
      const out = await wrong.delegate([{ tool: 'verify_caller', args: { owner_name: 'Jordan Lee', pet_name: null, phone: '720 555 0172' } }]);
      expect(out.errors).toEqual(['number_not_opened']);
      expect(handed(out)).not.toMatch(/biscuit|mochi|linh/i);
      expect(out.results[0]!.data.pets_on_number).toBeUndefined();
      expect(wrong.state.memory.verified).toBeNull();
      expect(await audited('patient.owner_check.no_match', wrong.callId)).toBe(1);
      // the pets on the number were never read
      expect(await audited('patient.pets_on_number.read', wrong.callId)).toBe(0);
      expect(await audited('patient.household.read.call', wrong.callId)).toBe(0);

      // no name given, even after "And the owner's name on that profile?": the same, nothing from the record
      const nameless = await w.call(null, { clinic, channel: 'web' });
      nameless.caller(lang === 'es' ? 'Es el 720 555 0172.' : 'It is 720 555 0172.');
      await nameless.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: null, phone: '720 555 0172' } }]);
      nameless.assistant("That's 720-555-0172?");
      nameless.caller('Yes.');
      const asked = await nameless.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: null, phone: '720 555 0172' } }]);
      expect(asked.errors).toEqual(['owner_check']);
      const still = await nameless.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: null, phone: '720 555 0172' } }]);
      expect(still.errors).toEqual(['number_not_opened']);
      expect(handed(still)).not.toMatch(/biscuit|mochi|linh/i);
      expect(await audited('patient.pets_on_number.read', nameless.callId)).toBe(0);
    }
  });

  it('a spoken number with no profile and a client\'s number with a wrong name get the same words and the same next step, EN and ES (2026-11-09)', async () => {
    for (const lang of ['en', 'es'] as const) {
      const said = async (phone: string, spoken: string, name: string) => {
        const c = await w.call(null, { clinic, channel: 'web' });
        if (lang === 'es') c.caller('Hola, quiero una cita, por favor.');
        // the name is asked first on both numbers: the question itself tells nothing
        c.caller(lang === 'es' ? `Es el ${phone}.` : `It is ${phone}.`);
        const first = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: null, phone } }]);
        expect(first.errors).toEqual(['confirm_number']);
        c.assistant(lang === 'es' ? `¿Es el ${spoken}?` : `That's ${spoken}?`);
        c.caller(lang === 'es' ? 'Sí.' : 'Yes.');
        const asked = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: null, phone } }]);
        expect(asked.errors).toEqual(['owner_check']);
        expect(handed(asked)).toContain(PACKS[lang].ownerNameQuestion);
        const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: name, pet_name: null, phone } }]);
        // a pet named straight away gets the same answer too, with nothing looked up
        const named = await c.delegate([{ tool: 'verify_caller', args: { owner_name: name, pet_name: 'Biscuit', phone } }]);
        // the next step is a request for the team, which goes through
        const request = await c.delegate([{ tool: 'create_callback', args: { reason: 'wants a check-up', callback_number: null, topic: null } }]);
        return { c, out, named, request };
      };
      const client = await said('720 555 0172', '720-555-0172', 'Jordan Lee');
      const stranger = await said('720 555 0199', '720-555-0199', 'Jordan Lee');
      for (const r of [client, stranger]) {
        expect(r.out.errors).toEqual(['number_not_opened']);
        expect(r.named.errors).toEqual(['number_not_opened']);
        expect(handed(r.out)).toContain(PACKS[lang].numberNotOpened);
        expect(handed(r.out)).toContain('create_callback');
        expect(handed(r.out)).not.toMatch(/biscuit|mochi|linh|don't see|no veo/i);
        expect(r.request.errors).toEqual([null]);
        expect(r.c.state.verifiedPatient).toBeNull();
      }
      // word for word the same, both answers
      expect(handed(client.out)).toBe(handed(stranger.out));
      expect(handed(client.named)).toBe(handed(stranger.named));
      // and the client's pets were never read
      expect(await audited('patient.pets_on_number.read', client.c.callId)).toBe(0);
    }
  });

  it('asks in Spanish on a Spanish call', async () => {
    const c = await w.call(LINH, { clinic });
    c.caller('Hola, buenos días, soy Linh. Quiero una cita, por favor.');
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: null } }]);
    expect(String(out.results[0]!.data.say)).toContain('"Gracias, Linh. ¿Es para Biscuit o para Mochi, o para una mascota nueva?"');
  });

  it('with no caller ID, asks for the number first; the number the caller says then opens its pets, as caller ID does (the text to the number on file is the safety net)', async () => {
    // no number at all: asked for one, nothing named
    for (const [number, opts] of [[null, {}], [null, { channel: 'web' as const }]] as const) {
      const c = await w.call(number, { clinic, ...opts });
      const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: null, phone: null } }]);
      expect(out.errors).toEqual(['phone_required']);
      expect(handed(out)).not.toMatch(/biscuit|mochi/i);
      expect(await audited('patient.pets_on_number.read', c.callId)).toBe(0);
    }
    // a number the caller says, on a browser test call: that number's pets, to pick from
    const web = await w.call(null, { clinic, channel: 'web' });
    // read back first, searched only after the yes
    web.caller('It is 720 555 0172.');
    const readBack = await web.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: null, phone: '720 555 0172' } }]);
    expect(readBack.errors).toEqual(['confirm_number']);
    expect(handed(readBack)).toContain("That's 720-555-0172?");
    expect(await audited('patient.pets_on_number.read', web.callId)).toBe(0);
    web.assistant("That's 720-555-0172?");
    web.caller('Yes.');
    const out = await web.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: null, phone: '720 555 0172' } }]);
    expect(out.results[0]!.data).toMatchObject({ pets_on_number: ['Biscuit', 'Mochi'], more: false });
    // the name they gave matches the owner on file: the record is theirs to hear
    expect(web.state.memory.verified).toBe('name_match');
    expect(await audited('patient.household.read.call', web.callId)).toBe(1);
    expect(await audited('patient.owner_check.match', web.callId)).toBe(1);
    // a number with nothing on it, said by the caller: the same answer as a client's number with a name that does not
    // match, so a caller can't tell which numbers are clients' (2026-11-09)
    const unknown = await w.call(null, { clinic, channel: 'web' });
    unknown.caller('It is 720 555 0199.');
    await unknown.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: null, phone: '720 555 0199' } }]);
    unknown.assistant("That's 720-555-0199?");
    unknown.caller('Yes, that is right.');
    const none = await unknown.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: null, phone: '720 555 0199' } }]);
    expect(none.errors).toEqual(['number_not_opened']);
    expect(handed(none)).toContain(PACKS.en.numberNotOpened);
    expect(handed(none)).not.toMatch(/biscuit|mochi|don't see a profile/i);
  });

  it('a number is one household: whoever calls from it hears every pet on it, whatever name they give, and the owner\'s name never unlocks or blocks a pet', async () => {
    await directory().create(clinic.id, { firstName: 'Juniper', lastName: 'Hale', dob: '2022-04-01', phone: LINH, guardianName: 'Grace Hale', gender: 'female', species: 'cat' });
    for (const owner of ['Grace', 'Linh', 'Ana', 'Lynn Nguyen']) {
      const c = await w.call(LINH, { clinic });
      const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: owner, pet_name: null } }]);
      expect(out.results[0]!.data.pets_on_number).toEqual(['Biscuit', 'Mochi', 'Juniper']);
      expect(c.state.verifyAttempts).toBe(0);
    }
    // the pet by name, said any way, without the owner's name at all
    const c = await w.call(LINH, { clinic });
    const found = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Moochi' } }]);
    expect(found.results[0]!.data).toMatchObject({ verified: true, pet_name: 'Mochi' });
    expect(c.state.verifiedOwner).toBe('Linh Nguyen');
    expect(await audited('patient.identified.by_number', c.callId)).toBe(1);
  });

  it('names at most three, then "or another one"', async () => {
    const many = '+17205550186';
    for (const name of ['Ash', 'Bean', 'Coco', 'Dot', 'Echo']) {
      await directory().create(clinic.id, { firstName: name, lastName: 'Moss', dob: '2020-01-01', phone: many, guardianName: 'Ivy Moss', gender: 'female', species: 'dog' });
    }
    const c = await w.call(many, { clinic });
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Ivy', pet_name: null } }]);
    expect(out.results[0]!.data).toMatchObject({ pets_on_number: ['Ash', 'Bean', 'Coco'], more: true });
    expect(String(out.results[0]!.data.say)).toContain(PACKS.en.whichPetVerified({ owner: 'Ivy', names: ['Ash', 'Bean', 'Coco'], more: true, offerNew: true }));
    expect(PACKS.en.whichPetVerified({ owner: 'Ivy', names: ['Ash', 'Bean', 'Coco'], more: true, offerNew: true })).toBe('Thanks, Ivy. Is this for Ash, Bean or Coco, or another one?');
    expect(PACKS.en.whichPet({ names: ['Ash', 'Bean', 'Coco'], more: true })).toBe('I see Ash, Bean and Coco under this number. Which one is it for, or is it another one?');
    expect(handed(out)).not.toMatch(/dot|echo/i);
  });
});

describe('one question about "new" per call: the pick question, or "Is it new to us?", never both', () => {
  it('with caller ID matched and the owner confirmed, asks only which pet, even when the pet is then described as a new one would be', async () => {
    const c = await w.call(LINH, { clinic });
    c.caller('Yes, that\'s me, Linh.');
    const asked = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: null } }]);
    expect(asked.results[0]!.data.pets_on_number).toEqual(expect.arrayContaining(['Biscuit', 'Mochi']));
    c.assistant('Is this for Biscuit or Mochi, or a new pet?');
    c.caller('It\'s for Mochi, she\'s a two-year-old female cat.');
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Mochi', phone: null } }]);
    expect(out.errors).toEqual([null]);
    expect(out.results[0]!.data).toMatchObject({ verified: true, pet_name: 'Mochi' });
    expect(c.state.askedIfNew).toBe(false);
  });

  it('holds when the pick question has no "new" in it ("or another one?")', async () => {
    const rowan = '+17205550187';
    for (const name of ['Fern', 'Gus', 'Hopper', 'Iris']) {
      await directory().create(clinic.id, { firstName: name, lastName: 'Pike', dob: '2021-01-01', phone: rowan, guardianName: 'Rowan Pike', gender: 'female', species: 'dog' });
    }
    const c = await w.call(rowan, { clinic });
    const asked = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Rowan', pet_name: null } }]);
    expect(asked.results[0]!.data).toMatchObject({ pets_on_number: ['Fern', 'Gus', 'Hopper'], more: true });
    c.assistant(PACKS.en.whichPet({ names: ['Fern', 'Gus', 'Hopper'], more: true }));
    c.caller('Another one, Iris. She\'s a five-year-old female.');
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Rowan', pet_name: 'Iris', phone: null } }]);
    expect(out.errors).toEqual([null]);
    expect(out.results[0]!.data).toMatchObject({ verified: true, pet_name: 'Iris' });
  });

  it('otherwise asks "Is it new to us?", and after it never the pick question, even with caller ID matched', async () => {
    const c = await w.call(LINH, { clinic });
    c.caller('Hi, I\'m Linh. I\'d like a check-up for my cat Clover, she\'s a one-year-old female.');
    const first = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Clover' } }]);
    expect(first.errors).toEqual(['ask_if_new']);
    expect(String(first.results[0]!.data.say)).toContain(PACKS.en.petNewQuestion({ pet: 'Clover' }));
    c.assistant('Is Clover new to us?');
    c.caller('Sorry, which pets do you have for me?');
    const then = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: null } }]);
    expect(then.errors).toEqual(['pet_name']);
    expect(handed(then)).not.toMatch(/biscuit|mochi|pets_on_number/i);
    expect(await audited('patient.pets_on_number.read', c.callId)).toBe(0);
  });
});

describe('the answer to "I see Biscuit and Mochi under this number. Which one is it for, or is it a new pet?"', () => {
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
    ['"another one" of theirs is not new', 'I see Ash, Bean and Coco under this number. Which one is it for, or is it another one?', 'Yes, another one, Dot.', '¿Es para Ash, Bean o Coco, o para otra mascota?', 'Sí, otra, Dot.', null],
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
  it('asks for the number first (never "Am I speaking with ...?" at a vet clinic), gives only when and how often the number called and whether a request is open, never a pet', async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ output: [], output_text: 'Done.' }));
    const planner = new ResponsesPlanner({ responses: { create } } as never, 'gpt-test');
    const c = await w.call(LINH, { clinic, history: 'Name on file for this number: Linh.\nCalls from this number in the last 30 days: 2.' });
    await c.delegate([], planner);
    const input = JSON.stringify((create.mock.calls[0]![0] as { input: unknown }).input);
    expect(input).not.toContain('Am I speaking with <that name>?');
    expect(input).toContain('A name on file is never the first question here: the number comes first');
    expect(input).toContain("Is your pet's profile under the number you're calling from, ending 0172?");
    expect(input).toContain('from the number alone you may say only how many times and when this number called');
    expect(input).toContain('whether a request from those calls is still open with the team');
    expect(input).toContain('never what it was about');
    expect(input).toContain('a pet\'s name comes only from there, never from these records');
    expect(input).not.toMatch(/biscuit|mochi/i);
  });
});
