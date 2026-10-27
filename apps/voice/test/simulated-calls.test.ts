import type { PlannerInput } from '@attendra/agent';
import { DEMO_CLINIC, starterClinic } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { simulatedCallFor } from '../src/simulated-calls';

/** Runs a simulated call's first delegation with a stand-in for the tools: what was asked, and what is said. */
async function firstTurn(clinic: Parameters<typeof simulatedCallFor>[0], slots: { slot_id: string; when: string; provider?: string }[]) {
  const call = simulatedCallFor(clinic)!;
  const asked: { name: string; args: unknown }[] = [];
  const out = await call.planner.plan({} as PlannerInput, async (name, args) => { asked.push({ name, args }); return { ok: true, data: { slots } }; });
  return { call, asked, say: out.say };
}

const SLOTS = [{ slot_id: 's1', when: 'Tuesday at 9:00 AM', provider: 'Dr. Elena Marsh' }, { slot_id: 's2', when: 'Tuesday at 9:20 AM', provider: 'Dr. Elena Marsh' }];

describe('a simulated call at any clinic', () => {
  it('a new clinic gets a new caller asking for times for a visit a new caller may book, and waits after the offer', async () => {
    const clinic = starterClinic({ id: 'clinic_new', name: 'Willow Bend Animal Clinic', timezone: 'America/Denver', industry: 'vet', phone: '+17205550161' });
    const { call, asked, say } = await firstTurn(clinic, SLOTS);
    // the wellness exam is for pets on file: the first a new caller may book is the sick visit
    expect(call.script.turns).toEqual([{ assistant: clinic.greeting }, { caller: 'Hi, I\'m new to the clinic. When could I come in for a sick visit?', delegate: true }]);
    expect(asked).toEqual([{ name: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } }]);
    expect(say).toBe('For a sick visit I can offer Tuesday at 9:00 AM, or Tuesday at 9:20 AM, with Dr. Elena Marsh. Would one of those work? And may I have your name?');
  });

  it('says so when there is no time, and speaks the clinic\'s first language', async () => {
    const clinic = { ...starterClinic({ id: 'clinic_es', name: 'Clínica Arroyo', timezone: 'America/Denver', industry: 'vet', phone: '+17205550161' }), primaryLanguage: 'es' as const, languages: ['es' as const, 'en' as const] };
    const none = await firstTurn(clinic, []);
    expect(none.call.script.turns[1]).toEqual({ caller: 'Hola, es la primera vez que llamo. ¿Cuándo tienen hora para consulta por enfermedad?', delegate: true });
    expect(none.say).toBe('No encontré un horario esta semana. Puedo pedir que la recepción le devuelva la llamada.');
    expect((await firstTurn(clinic, SLOTS)).say).toBe('Para consulta por enfermedad puedo ofrecerle Tuesday at 9:00 AM, o Tuesday at 9:20 AM, con Dr. Elena Marsh. ¿Le sirve alguna? ¿Y me dice su nombre?');
  });

  it('the demo clinic keeps its own call, with the demo patient', () => {
    expect(simulatedCallFor(DEMO_CLINIC)!.script.turns[1]).toMatchObject({ caller: expect.stringContaining('Maria Delgado') });
  });
});
