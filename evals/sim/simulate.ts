// SPDX-License-Identifier: AGPL-3.0-only
import type { Planner } from '@attendra/agent';
import { DEMO_CLINICS, zonedInstant } from '@attendra/core';
import { CallRepository, createPhiCipher, seedCedarPark, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { LocalEmbedder, seedDemoKnowledge } from '@attendra/knowledge';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { TextAssistant } from './assistant';
import type { Line, Persona, SimulatedCaller } from './caller';

const PersonaSchema = z.object({
  id: z.string(), clinic: z.enum(['maple', 'cedar_park']), caller_number: z.string().nullable(), persona: z.string(), goal: z.string(), expect: z.array(z.string()).min(1),
});
export const loadPersonas = (file = join(import.meta.dirname, 'personas.yaml')): Persona[] => z.array(PersonaSchema).parse(parse(readFileSync(file, 'utf8')));

export interface Simulation {
  persona: Persona;
  transcript: Line[];
  result: ReturnType<TextAssistant['result']>;
  goalMet: boolean;
}

// A weekday morning in Denver, when the clinic is open and has times to offer
const SIM_NOW = zonedInstant('2026-09-29', '09:30', DEMO_CLINICS.maple.timezone);

/**
 * One simulated call, in a fresh in-process database seeded with the demo clinic:
 * the caller and the assistant take turns until the caller hangs up, the call is
 * transferred or ends, or `maxTurns` is reached.
 */
export async function simulate(persona: Persona, caller: SimulatedCaller, planner: Planner, maxTurns = 12): Promise<Simulation> {
  const t = await openTestDatabase();
  try {
    const cipher = createPhiCipher(TEST_DATA_KEY);
    await (persona.clinic === 'cedar_park' ? seedCedarPark : seedDemo)(t.db, cipher);
    if (persona.clinic === 'maple') await seedDemoKnowledge(t.db, new LocalEmbedder());
    const clinic = DEMO_CLINICS[persona.clinic];
    const callId = await new CallRepository(t.db, cipher).open(clinic.id, `sim_${persona.id}_${Date.now()}`, persona.caller_number);
    const assistant = new TextAssistant(t.db, clinic, callId, persona.caller_number, planner, () => SIM_NOW);
    const transcript: Line[] = [{ speaker: 'assistant', text: assistant.greeting }];
    for (let turn = 0; turn < maxTurns; turn++) {
      const line = await caller.next(transcript);
      if (line.text) transcript.push({ speaker: 'caller', text: line.text });
      if (!line.text && line.hangup) break;
      const { reply, ended } = await assistant.hear(line.text);
      transcript.push({ speaker: 'assistant', text: reply });
      if (ended || line.hangup) break;
    }
    const result = assistant.result();
    return { persona, transcript, result, goalMet: persona.expect.includes(result.outcome ?? '') };
  } finally {
    await t.close();
  }
}
