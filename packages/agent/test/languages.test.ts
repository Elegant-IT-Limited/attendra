import { DEMO_CLINIC } from '@attendra/core';
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

  it('answers a Spanish emergency in the call\'s language when the clinic does not speak Spanish', async () => {
    const c = await w.call('+13035550147', { clinic: { ...DEMO_CLINIC, languages: ['en'], primaryLanguage: 'en' } });
    c.caller('Hello, I need to book a visit for my father.');
    const out = c.caller('me duele mucho el pecho');
    expect(out[0]).toMatchObject({ type: 'instructions' });
    expect(said(out)).toContain('hang up and call 911');
    expect(c.state.language).toBe('en'); // Spanish is not offered here, so the call stays in English
  });

  it('stays in English for an English caller, whatever else the clinic speaks', async () => {
    const c = await w.call();
    c.caller('Hi, I would like to book an appointment for next week please.');
    expect(c.state.language).toBe('en');
  });
});

describe('the clinic\'s FAQ', () => {
  it('answers English questions as before', () => {
    expect(answerFromFaqs(DEMO_CLINIC.faqs, 'which insurance do you accept')?.id).toBe('faq_insurance');
  });
});
