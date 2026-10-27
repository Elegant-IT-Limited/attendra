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

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(); });
afterAll(() => w.t.close());

describe('language parity: the lines the agent says word for word', () => {
  it('every pack has its own take-over and apology lines', () => {
    expect(PACKS.es.takeOver).not.toBe(PACKS.en.takeOver);
    expect(PACKS.es.tooSlow).not.toBe(PACKS.en.tooSlow);
    expect(PACKS.es.couldNotFinish).not.toBe(PACKS.en.couldNotFinish);
  });

  it('every pack asks whether a pet is new, and reads back a number as given, in its own words (2026-11-08)', () => {
    expect(PACKS.en.petNewQuestion({ pet: 'Hazel' })).toBe('Is Hazel new to us?');
    expect(PACKS.es.petNewQuestion({ pet: 'Hazel' })).toBe('¿Es la primera vez que Hazel viene con nosotros?');
    expect(PACKS.en.phoneAsGiven({ digits: '995 72 124' })).toContain('995 72 124');
    expect(PACKS.es.phoneAsGiven({ digits: '995 72 124' })).toContain('995 72 124');
    expect(PACKS.es.phoneAsGiven({ digits: '1' })).not.toBe(PACKS.en.phoneAsGiven({ digits: '1' }));
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
