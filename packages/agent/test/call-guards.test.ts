// SPDX-License-Identifier: AGPL-3.0-only
import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askedWhy, claimsIn, notInTheClinicsLanguages, recordingLine } from '../src/flow/guards';
import { world } from './support';

// Batch 1b, the rest of the 11-16 set: the real reason on "why?", no result without a tool, the facts checked again,
// honest answers about recording and about being an AI, side talk never translated, a callback number never asked twice.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const open = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const instructions = (out: { type: string; content?: string }[]) => out.filter((o) => o.type === 'instructions').map((o) => o.content ?? '').join(' ');

describe('the guards on the caller\'s words', () => {
  it('answers "why?" with the reason of the last refusal, not the same line again', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    c.caller('What did the vet find at her last visit?');
    const out = await c.delegate([{ tool: 'visit_summary', args: {} }]);
    expect(out.errors[0]).toBeTruthy();
    const why = instructions(c.caller('Can you specify why?'));
    expect(why).toContain('The caller asks why');
    expect(why).toContain('without repeating your last line');
    expect(askedWhy('¿Por qué no?')).toBe(true);
    expect(askedWhy('why not')).toBe(true);
  });

  it('checks again when the caller disputes a fact, and never takes back emergency advice', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    expect(instructions(c.caller("That's not right, you're open until 8 tonight."))).toContain('Check again with the tool');
    c.assistant('I checked again: we close at 6 today.');
    expect(instructions(c.caller('Eso no es cierto, me dijeron que abren a las 7.'))).toContain('never take back advice about an emergency');
  });

  it('answers "are you recording?" from the clinic\'s setting, and "are you a real person?" honestly', async () => {
    const off = await w.call('+17205550172', { clinic: { ...open, recording: { enabled: false } } });
    expect(instructions(off.caller('Are you recording this call?'))).toContain("This call isn't recorded as audio. A written summary is kept for the clinic.");
    expect(recordingLine({ recording: { enabled: true } } as never, 'es')).toContain('puede grabarse');
    const c = await w.call('+17205550172', { clinic: open });
    expect(instructions(c.caller('Wait, am I talking to a real person?'))).toContain("I'm the clinic's AI assistant.");
    c.assistant("I'm the clinic's AI assistant.");
    // how it is made is not the clinic's business: the one polite line (batch 2)
    expect(instructions(c.caller('Which AI model are you running on?'))).toContain('I can help with questions about the clinic, appointments and your pet.');
  });

  it('never translates side talk in another language: one line, once, then it waits', async () => {
    const c = await w.call('+17205550172', { clinic: { ...open, languages: ['en', 'es'] } });
    expect(notInTheClinicsLanguages('Подожди минутку, я разговариваю по телефону')).toBe(true);
    expect(notInTheClinicsLanguages('Hola, quisiera una cita')).toBe(false);
    const first = instructions(c.caller('Подожди минутку, я разговариваю по телефону'));
    expect(first).toContain('Do not translate it');
    expect(first).toContain('Sorry, I can help in English or Spanish.');
    c.assistant('Sorry, I can help in English or Spanish.');
    const again = instructions(c.caller('Да, сейчас, одну секунду'));
    expect(again).toContain('say nothing and wait');
    expect(again).not.toContain('Sorry, I can help');
  });
});

describe('no result without a tool', () => {
  it('corrects "I couldn\'t find a file" when no search ran, once, and lets a real one stand', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    c.caller('Hi, I want to book Biscuit.');
    const out = c.agent.onAgentTranscript("I'm sorry, I couldn't find a pet file under that number.", 5000, 7000);
    expect(instructions(out)).toContain('no tool returned (not found)');
    expect(c.agent.onAgentTranscript(' I could not find it.', 7000, 8000)).toEqual([]);
    expect(claimsIn('Great, you are all booked for Thursday at 10.')).toEqual(['booked']);
    expect(claimsIn('Shall I book Biscuit for Thursday at 10?')).toEqual([]);
    expect(claimsIn('Ya está reservada su cita.')).toEqual(['booked']);
  });

  it('a vet\'s day said before any lookup is a claim; after a slot search it is the schedule (batch 1c, live runs)', async () => {
    expect(claimsIn('No, Dr. Vance isn\'t in on Tuesday.')).toEqual(['vet_day']);
    expect(claimsIn('Lo siento, la doctora Vance no está disponible el viernes.')).toEqual(['vet_day']);
    expect(claimsIn('No, la doctora Vance no está el martes.')).toEqual(['vet_day']);
    expect(claimsIn('Dr. Vance sees patients on Fridays and Sundays.')).toEqual([]);
    const c = await w.call('+17205550172', { clinic: open });
    c.caller('Is Dr. Ruiz in on Tuesday?');
    expect(instructions(c.agent.onAgentTranscript("No, Dr. Ruiz isn't in on Tuesday.", 5000, 7000))).toContain('no tool returned (vet day)');
    const after = await w.call('+17205550172', { clinic: open });
    after.caller('Is Dr. Ruiz in on Tuesday?');
    await after.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(after.agent.onAgentTranscript("No, Dr. Ruiz isn't in on Tuesday.", 9000, 11000)).toEqual([]);
  });

  it('the clinic\'s information does not back a vet\'s day, and points the model to the slot search (batch 1d, live runs)', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    c.caller('Is Dr. Ruiz in on Tuesday?');
    const [info] = (await c.delegate([{ tool: 'get_clinic_info', args: { question: 'Is Dr. Ruiz in on Tuesday?' } }])).results;
    expect(String(info!.data.vet_day)).toContain('only from find_slots');
    expect(instructions(c.agent.onAgentTranscript("No, Dr. Ruiz isn't in on Tuesday.", 9000, 11000))).toContain('no tool returned (vet day)');
    // a question with no vet and day carries no such note
    const plain = await w.call('+17205550172', { clinic: open });
    plain.caller('What are your hours?');
    const [hours] = (await plain.delegate([{ tool: 'get_clinic_info', args: { question: 'opening hours' } }])).results;
    expect(hours!.data.vet_day).toBeUndefined();
  });
});

describe('helpful within the rules', () => {
  it('"which vet is good for allergies?" lists the vets by their specialties instead of refusing it as medical', async () => {
    const c = await w.call('+17205550172', { clinic: open });
    c.caller('Which vet is good for allergies?');
    const out = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'Which vet is good for allergies?' } }]);
    expect(out.errors).toEqual([null]);
    expect(JSON.stringify(out.results[0]!.data)).toContain('listed specialties');
  });

  it('takes a callback on the number the caller already gave, never asking for it again', async () => {
    const c = await w.call(null, { clinic: open });
    c.caller('My number is 720 555 0174.');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Luna', phone: '720 555 0174' } }]);
    c.caller('Just have someone call me back about her food.');
    const out = await c.delegate([{ tool: 'create_callback', args: { reason: 'Question about Luna\'s food', callback_number: null } }]);
    expect(out.errors).toEqual([null]);
  });
});
