import { PACKS } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promisesCallback } from '../src';
import { world } from './support';

/**
 * The agent's half of packages/core/test/language-parity.test.ts: what the assistant says,
 * read in English and in Spanish, gives the same answer.
 */
const ROWS: [behaviour: string, english: string, spanish: string, expected: boolean][] = [
  ['pass it along', "I'll pass that along to the team.", 'Le paso el mensaje al equipo.', true],
  ['let the team know', "I'll let the team know.", 'Se lo hago saber al equipo.', true],
  ['someone will call back', 'Someone from the clinic will call you back.', 'Alguien de la clínica le llamará.', true],
  ['they will call', 'The team will call you tomorrow morning.', 'Le llamarán mañana por la mañana.', true],
  ['have someone call', "I'll have someone call you.", 'Le devolverán la llamada hoy.', true],
  ['be in touch', 'The team will be in touch.', 'El equipo se pondrá en contacto con usted.', true],
  ['tell the team', "I'll let the team know you called.", 'Le aviso al equipo que llamó.', true],
  ['an offer is not a promise', 'Would you like me to book that?', '¿Quiere que se la reserve?', false],
  ['the hours are not a promise', 'We open at eight tomorrow.', 'Abrimos mañana a las ocho.', false],
];

describe('language parity: the callback-promise check', () => {
  it.each(ROWS)('%s', (_behaviour, english, spanish, expected) => {
    expect(promisesCallback(english), english).toBe(expected);
    expect(promisesCallback(spanish), spanish).toBe(expected);
  });
});

/** The lines about an owner's pets and a pet's visits (2026-11), word for word in both languages: the same facts, and a question stays a question. */
const SEPT_14 = new Date('2026-09-14T15:00:00Z');
const PET_LINES: [behaviour: string, line: (l: 'en' | 'es') => string, english: string, spanish: string][] = [
  ['which pet: two names', (l) => PACKS[l].whichPet({ names: ['Biscuit', 'Max'], more: false }), 'Is this for Biscuit or Max, or a new pet?', '¿Es para Biscuit o Max, o para una mascota nueva?'],
  ['which pet: one name', (l) => PACKS[l].whichPet({ names: ['Biscuit'], more: false }), 'Is this for Biscuit, or a new pet?', '¿Es para Biscuit, o para una mascota nueva?'],
  ['which pet: three, and others', (l) => PACKS[l].whichPet({ names: ['Ash', 'Bean', 'Oreo'], more: true }), 'Is this for Ash, Bean or Oreo, or another one?', '¿Es para Ash, Bean u Oreo, o para otra mascota?'],
  ['the last visit I can see', (l) => PACKS[l].lastVisitSeen({ pet: 'Biscuit', when: PACKS[l].speakWhen(SEPT_14, 'America/Denver'), provider: 'Dr. Elena Ruiz', visit: 'Wellness exam' }),
    'The last visit I can see for Biscuit was on Monday, September 14 at 9:00 AM with Dr. Elena Ruiz, for a wellness exam.',
    `La última visita que veo de Biscuit fue el ${PACKS.es.speakWhen(SEPT_14, 'America/Denver')} con Dr. Elena Ruiz, para wellness exam.`],
  ['the last visit I can see: no vet or kind known', (l) => PACKS[l].lastVisitSeen({ pet: 'Biscuit', when: 'Monday', provider: null, visit: null }), 'The last visit I can see for Biscuit was on Monday.', 'La última visita que veo de Biscuit fue el Monday.'],
  ['records in writing, never medical details', (l) => PACKS[l].recordsOffer,
    "I can't go into medical details on the phone, but I can ask the team to send you the records in writing. Would you like that?",
    'No puedo dar detalles médicos por teléfono, pero puedo pedirle al equipo que le envíe el historial por escrito. ¿Le parece bien?'],
];

describe('language parity: what the assistant says about pets and visits', () => {
  it.each(PET_LINES)('%s', (_behaviour, line, english, spanish) => {
    expect(line('en')).toBe(english);
    expect(line('es')).toBe(spanish);
    expect(english.endsWith('?')).toBe(spanish.endsWith('?'));
  });
});

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); });
afterAll(() => w.t.close());

describe('language parity: the lines the agent says word for word', () => {
  it('every pack has its own take-over and apology lines', () => {
    expect(PACKS.es.takeOver).not.toBe(PACKS.en.takeOver);
    expect(PACKS.es.tooSlow).not.toBe(PACKS.en.tooSlow);
    expect(PACKS.es.couldNotFinish).not.toBe(PACKS.en.couldNotFinish);
  });

  it('a take-over in a Spanish call is said in Spanish', async () => {
    const c = await w.call();
    c.caller('Hola, buenas noches. Quiero una cita para mi hija, por favor.');
    expect(c.state.language).toBe('es');
    const out = c.agent.takeOver('tel:+13035550101');
    expect(out[0]).toMatchObject({ type: 'instructions', content: expect.stringContaining(PACKS.es.takeOver) });
  });

  it('a request that fails in a Spanish call is apologised for in Spanish', async () => {
    const c = await w.call();
    c.caller('Hola, buenas noches. Necesito cambiar mi cita, por favor.');
    const out = await c.delegate([], { plan: async () => { throw new Error('planner down'); } });
    expect(out).toContainEqual(expect.objectContaining({ type: 'commentary', content: PACKS.es.couldNotFinish }));
  });
});
