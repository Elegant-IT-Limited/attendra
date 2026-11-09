import { describe, expect, it } from 'vitest';
import { loadScenarios, type Scenario } from '../src/scenario';
import { runScenario } from '../src/simulator';

/**
 * The team's note on a booking is read back decrypted, and a wrong or missing note fails the scenario. The example is a
 * pet found by the last four digits, whose booking carries that note (a spoken number with a wrong name no longer books
 * at all since 2026-11-09).
 */
describe('the appointment note expectation', () => {
  const lastFour = loadScenarios().find((s) => s.id === 'vet-two-wrong-readbacks-last-four')!;
  const withExpect = (expect: Partial<Scenario['expect']>): Scenario => ({ ...lastFour, expect: { ...lastFour.expect, ...expect } });

  it('passes on the note the call wrote, decrypted with the call\'s cipher', async () => {
    const result = await runScenario(withExpect({ appointment_note_contains: ['found on the call by the last four digits'] }));
    expect(result.failures).toEqual([]);
  }, 60_000);

  it('fails on a note the call did not write, and when a note was expected to be empty', async () => {
    const result = await runScenario(withExpect({ appointment_note_contains: ['booked by caller: Sam'], appointment_note_empty: true }));
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatch(/^no appointment note says "booked by caller: Sam" \(notes: \[".*found on the call by the last four digits.*"\]\)$/);
    expect(result.failures[1]).toBe('an appointment made on the call carries a note, expected none');
  }, 60_000);
});
