// SPDX-License-Identifier: AGPL-3.0-only
import type { Planner } from '@attendra/agent';
import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/scenario';
import { runScenario } from '../src/simulator';

// The owner's final live run (adv-contradiction-latest-day): the scripted caller said "Yes." before the voice had read
// the booking back. Live, a line with wait_for waits for those words in the assistant's last reply, saying `meanwhile`
// at most twice. Scripted play is unchanged. No model is called here.
describe('LIVE-WAIT-FOR: the scripted caller waits for the read-back before its yes', () => {
  const byId = (id: string) => loadScenarios().find((s) => s.id === id)!;
  const voice = (replies: string[]): Planner => ({ readsNotes: true, plan: async () => ({ say: replies.shift() ?? 'Okay.' }) });
  const callerLines = (r: Awaited<ReturnType<typeof runScenario>>) => r.transcript.filter((t) => t.speaker === 'caller').map((t) => t.text);

  it('LIVE-WAIT-FOR: a voice that asks which time first gets "The first one, please." before the yes (EN)', async () => {
    const r = await runScenario(byId('adv-contradiction-latest-day'), voice(['I found Biscuit. On Thursday I have 8:00 or 8:20.', 'Sure, which one?', 'Shall I book Thursday at 8:00?', 'Done.']));
    expect(callerLines(r).slice(1)).toEqual(['The first one.', 'The first one, please.', 'Yes.']);
  }, 60_000);

  it('LIVE-WAIT-FOR: a read-back right away gets the yes at once; a voice that never reads back gets the yes after two waits (ES)', async () => {
    const now = await runScenario(byId('adv-es-contradiction-latest-day'), voice(['Encontré a Biscuit. El jueves tengo a las 8:00 o 8:20.', '¿Lo reservo el jueves a las 8:00?', 'Listo.']));
    expect(callerLines(now).slice(1)).toEqual(['La primera.', 'Sí.']);
    const never = await runScenario(byId('adv-es-contradiction-latest-day'), voice(['Encontré a Biscuit.', '¿Cuál?', '¿Cuál?', '¿Cuál?']));
    expect(callerLines(never).slice(1)).toEqual(['La primera.', 'La primera, por favor.', 'La primera, por favor.', 'Sí.']);
  }, 60_000);
});
