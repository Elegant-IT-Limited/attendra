import { PACKS, RIVERBEND_CLINIC } from '@attendra/core';
import { createPhiCipher, phiContext, seedRiverbend } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// Use the record (2026-11-14): caller ID knows the owner; a spoken number is checked by name, which only decides what is
// said, never whether the caller can book; a known number's new pet joins its owner with no question.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const handed = (out: { results: { data: Record<string, unknown> }[] }) => JSON.stringify(out.results.map((r) => r.data));
const cipher = createPhiCipher(TEST_DATA_KEY);

describe('caller ID', () => {
  it('never asks the name, and a new pet joins the owner on file', async () => {
    const c = await w.call('+17205550173', { clinic });
    c.caller('Hi, I\'d like to book a check-up for a new pet, my puppy, a boy, about four months old.');
    const out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Rolo', owner_name: null, species: null, sex: null, birthday_or_age: null, phone: null } }]);
    expect(out.errors).toEqual([null]);
    expect(out.results[0]!.data.registered).toBe(true);
    expect(c.state.verifiedPatient).toMatchObject({ firstName: 'Rolo', species: 'dog', guardianName: 'Daniel Brooks' });
    expect(handed(out)).not.toMatch(/your name|su nombre/i);
    // one owner on the number, still
    const owners = (await w.t.db.execute(sql`select count(distinct guardian_name_enc)::int as n from patients where clinic_id = ${clinic.id} and first_name_enc is not null and id = ${c.state.verifiedPatient!.id}`)).rows[0] as { n: number };
    expect(owners.n).toBe(1);
  });
});

describe('caller ID and the pet named at once', () => {
  it('thanks the caller by the owner\'s name on file before the pet found, once a call', async () => {
    const c = await w.call('+17205550174', { clinic });
    c.caller('Hi, I\'d like to book a check-up for Luna.');
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Luna', phone: null } }]);
    expect(out.errors).toEqual([null]);
    expect(handed(out)).toContain('Thanks, Carmen. I found Luna, your dog.');
    expect(c.state.memory.greeted).toBe(true);
  });
});

describe('a number the caller says', () => {
  async function onWeb() {
    const c = await w.call(null, { clinic, channel: 'web' });
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: null, phone: '720 555 0172' } }]);
    c.assistant("That's 720-555-0172?");
    c.caller('Yes.');
    return c;
  }

  it('asks "And your name?" once, and a name that sounds like the owner\'s greets them by the name on file', async () => {
    const c = await onWeb();
    const asked = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: null, phone: '720 555 0172' } }]);
    expect(asked.errors).toEqual(['owner_check']);
    expect(handed(asked)).toContain(PACKS.en.yourNameQuestion);
    expect(handed(asked)).not.toMatch(/linh|biscuit|mochi/i);
    c.assistant('And your name?');
    c.caller('Lính.');
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Lính', pet_name: null, phone: '720 555 0172' } }]);
    expect(handed(out)).toContain('Thanks, Linh. Is this for Biscuit or Mochi, or a new pet?');
    expect(c.state.memory.verified).toBe('name_match');
  });

  it('a name that does not match still books, says nothing from the record, and notes who booked it', async () => {
    const c = await onWeb();
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: null, phone: '720 555 0172' } }]);
    c.assistant('And your name?');
    c.caller('Alex.');
    const pick = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Alex', pet_name: null, phone: '720 555 0172' } }]);
    expect(pick.results[0]!.data).toMatchObject({ pets_on_number: ['Biscuit', 'Mochi'] });
    expect(handed(pick)).not.toMatch(/linh|nguyen|thanks,/i);
    c.caller('Biscuit.');
    const found = await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Alex', pet_name: 'Biscuit', phone: '720 555 0172' } }]);
    expect(found.results[0]!.data).toMatchObject({ verified: true, pet_name: 'Biscuit' });
    // nothing from the record
    const visits = await c.delegate([{ tool: 'visit_summary', args: {} }]);
    expect(visits.errors).toEqual(['not_verified']);
    expect(handed(visits)).not.toMatch(/linh|ruiz|last visit/i);
    // still books, with a note for the team
    c.caller('Wednesday morning please.');
    const slots = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_wellness', provider_id: null, from_date: '2026-09-30', part_of_day: 'morning' } }]);
    const slot = (slots.results[0]!.data.slots as { slot_id: string }[])[0]!.slot_id;
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: slot, replaces_appointment_id: null } }]);
    c.assistant('Shall I book it?');
    c.caller('Yes.');
    const booked = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(booked.results[0]!.data.booked).toBe(true);
    expect(handed(booked)).not.toMatch(/linh/i);
    const [row] = (await w.t.db.execute(sql`select note_enc from appointments where created_by_call_id = ${c.callId}`)).rows as { note_enc: string | null }[];
    expect(row!.note_enc).not.toBeNull();
    expect(cipher.decrypt(row!.note_enc!, phiContext(clinic.id, 'appointments.note'))).toBe('booked by caller: Alex');
    expect(c.state.memory.verified).toBeNull();
  });

  it('a caller who does not give a name is asked once, then helped without the record', async () => {
    const c = await onWeb();
    const asked = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' } }]);
    expect(asked.errors).toEqual(['owner_check']);
    c.caller('Why do you need that? It\'s for Biscuit.');
    const out = await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' } }]);
    expect(out.errors).toEqual([null]);
    expect(c.state.memory.nameCheck).toMatchObject({ result: 'not_given' });
    expect((await c.delegate([{ tool: 'visit_summary', args: {} }])).errors).toEqual(['not_verified']);
  });

  it('a new pet on a known number is added under its owner whatever name the caller gave', async () => {
    const c = await onWeb();
    c.caller('I\'m Sam, and it\'s for a new kitten, a girl, three months old.');
    const out = await c.delegate([{ tool: 'register_patient', args: { pet_name: 'Fig', owner_name: 'Sam', species: null, sex: null, birthday_or_age: null, phone: '720 555 0172' } }]);
    expect(out.errors).toEqual([null]);
    expect(c.state.verifiedPatient).toMatchObject({ firstName: 'Fig', guardianName: 'Linh Nguyen' });
    const [task] = (await w.t.db.execute(sql`select details_enc from tasks where call_id = ${c.callId} and type = 'review'`)).rows as { details_enc: string }[];
    expect(JSON.parse(cipher.decrypt(task!.details_enc, phiContext(clinic.id, 'tasks.details')))).toMatchObject({ note: 'booked by caller: Sam' });
  });
});
