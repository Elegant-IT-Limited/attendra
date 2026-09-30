import { DEMO_CLINIC, DHANMONDI_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerFromFaqs, type CallAgent } from '../src';
import { world } from './support';

type Out = Awaited<ReturnType<CallAgent['onDelegation']>>;
const said = (out: Out) => out.flatMap((o) => (o.type === 'commentary' || o.type === 'instructions' ? [o.content] : [])).join(' ');

describe('a Spanish call at Maple Street', () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world(); });
  afterAll(() => w.t.close());

  it('starts in English, then offers, reads back and texts in Spanish once the caller speaks it', async () => {
    const c = await w.call();
    expect(c.state.language).toBe('en');
    c.caller('Hola, soy Maria Delgado, nací el 4 de marzo de 1985. Necesito una cita, por favor.');
    expect(c.state.language).toBe('es');
    const found = await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: '4 de marzo de 1985' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
    ]);
    expect(said(found)).toContain('martes, 29 de septiembre a las 8:00');
    c.caller('La primera, por favor.');
    const proposed = await c.delegate([{ tool: 'propose_booking', args: { slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null } }]);
    expect(c.state.pending?.readback).toBe('martes, 29 de septiembre a las 8:00 a.m. con Dr. Nkem Okafor, para consulta por enfermedad');
    expect(said(proposed)).toContain('consulta por enfermedad');
    c.assistant('Para confirmar: martes a las 8 con la doctora Okafor. ¿Está bien?');
    c.caller('Sí, está bien.');
    await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(c.state.outcome).toBe('booked');
    expect(w.sms.at(-1)).toMatchObject({ template: 'booking_confirmed', language: 'es', when: 'martes, 29 de septiembre a las 8:00 a.m.' });
  });

  it('gives the emergency script in Spanish, with 911 and 988', async () => {
    const c = await w.call();
    const out = c.caller('Por favor, ya no quiero vivir');
    expect(said(out)).toContain('llame al 911');
    expect(said(out)).toContain('988');
  });

  it('answers a Bangla emergency in the call\'s language when the clinic does not speak Bangla', async () => {
    const c = await w.call();
    c.caller('Hello, I need to book a visit for my father.');
    const out = c.caller('বাবার বুকে খুব ব্যথা');
    expect(out[0]).toMatchObject({ type: 'instructions' });
    expect(said(out)).toContain('hang up and call 911');
    expect(c.state.language).toBe('en'); // Bangla is not offered here, so the call stays in English
  });

  it('stays in English for an English caller, whatever else the clinic speaks', async () => {
    const c = await w.call();
    c.caller('Hi, I would like to book an appointment for next week please.');
    expect(c.state.language).toBe('en');
  });
});

describe('a Bangla call at Dhanmondi', () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeAll(async () => { w = await world('dhanmondi'); });
  afterAll(() => w.t.close());

  it('books in Bangla with a day-first date of birth, and the text is in Bangla', async () => {
    const c = await w.call('+8801000000113');
    expect(c.state.language).toBe('bn');
    c.caller('Ami Tahmina Akter, date of birth 20/02/1992. Ekta blood test korte chai.');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Tahmina Akter', date_of_birth: '20/02/1992' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_blood', provider_id: null, from_date: null, part_of_day: 'any' } },
    ]);
    expect(c.state.verifiedPatient?.firstName).toBe('Tahmina');
    c.caller('প্রথমটা দিন');
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null } }]);
    expect(c.state.pending?.readback).toBe('মঙ্গলবার, ২৯ সেপ্টেম্বর, সকাল ১০টা, নমুনা সংগ্রহ কক্ষ-এর কাছে, রক্ত পরীক্ষা');
    c.assistant('নিশ্চিত করছি: মঙ্গলবার সকাল ১০টা, রক্ত পরীক্ষা। ঠিক আছে?');
    c.caller('জি, ঠিক আছে');
    await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(c.state.outcome).toBe('booked');
    expect(w.sms.at(-1)).toMatchObject({ to: '+8801000000113', language: 'bn' });
  });

  it('refuses "ji, pore" and books nothing', async () => {
    const c = await w.call('+8801000000112');
    c.caller('Ami Anisur Rahman, 3 November 1968. ECG korate chai.');
    await c.delegate([
      { tool: 'verify_caller', args: { full_name: 'Anisur Rahman', date_of_birth: '3 November 1968' } },
      { tool: 'find_slots', args: { visit_type_id: 'vt_ecg', provider_id: null, from_date: null, part_of_day: 'any' } },
    ]);
    c.caller('ওইটা');
    await c.delegate([{ tool: 'propose_booking', args: { slot_id: [...c.state.offered.keys()][0]!, replaces_appointment_id: null } }]);
    c.assistant('ঠিক আছে?');
    c.caller('Ji... pore janabo');
    const out = await c.delegate([{ tool: 'commit_pending', args: {} }]);
    expect(out.errors).toEqual(['no_clear_yes']);
  });

  it('gives the 999 line in Bangla and never rings anyone, since the centre has no on-call line', async () => {
    const c = await w.call();
    const out = c.caller('মা অজ্ঞান হয়ে গেছে');
    expect(said(out)).toContain('৯৯৯ নম্বরে কল করুন');
    expect(said(out)).not.toMatch(/911|988/);
    expect(out.some((o) => o.type === 'transfer')).toBe(false);
  });

  it('refuses a write after an emergency with the clinic\'s own number', async () => {
    const c = await w.call();
    c.caller('shash nite parche na');
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_blood', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(said(out)).toContain('999');
    expect(said(out)).not.toContain('911');
  });
});

describe('the clinic\'s FAQ, in any script', () => {
  it('answers Bangla, romanised Bangla and English questions from the same entries', () => {
    expect(answerFromFaqs(DHANMONDI_CLINIC.faqs, 'রিপোর্ট কবে পাবো')?.id).toBe('faq_reports');
    expect(answerFromFaqs(DHANMONDI_CLINIC.faqs, 'test er report kobe pabo')?.id).toBe('faq_reports');
    expect(answerFromFaqs(DHANMONDI_CLINIC.faqs, 'CBC er dam koto taka')?.id).toBe('faq_prices');
    expect(answerFromFaqs(DHANMONDI_CLINIC.faqs, 'খালি পেটে আসতে হবে?')?.id).toBe('faq_fasting');
    expect(answerFromFaqs(DHANMONDI_CLINIC.faqs, 'do you do home collection in Mohammadpur')?.id).toBe('faq_home');
  });

  it('still answers English questions as before', () => {
    expect(answerFromFaqs(DEMO_CLINIC.faqs, 'which insurance do you accept')?.id).toBe('faq_insurance');
  });
});
