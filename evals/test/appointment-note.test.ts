import { describe, expect, it } from 'vitest';
import { loadScenarios, type Scenario } from '../src/scenario';
import { runScenario } from '../src/simulator';

/** The team's note on a booking ("booked by caller: Alex") is read back decrypted, and a wrong or missing note fails the scenario. */
describe('the appointment note expectation', () => {
  const wrongName = loadScenarios().find((s) => s.id === 'vet-spoken-number-wrong-name')!;
  const withExpect = (expect: Partial<Scenario['expect']>): Scenario => ({ ...wrongName, expect: { ...wrongName.expect, ...expect } });

  it('passes on the note the call wrote, decrypted with the call\'s cipher', async () => {
    const result = await runScenario(withExpect({ appointment_note_contains: ['booked by caller: Alex'] }));
    expect(result.failures).toEqual([]);
  }, 60_000);

  it('fails on a note the call did not write, and when a note was expected to be empty', async () => {
    const result = await runScenario(withExpect({ appointment_note_contains: ['booked by caller: Sam'], appointment_note_empty: true }));
    expect(result.failures).toEqual([
      'no appointment note says "booked by caller: Sam" (notes: ["booked by caller: Alex"])',
      'an appointment made on the call carries a note, expected none',
    ]);
  }, 60_000);
});
