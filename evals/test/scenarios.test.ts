import { describe, expect, it } from 'vitest';
import { loadScenarios } from '../src/scenario';
import { runScenario } from '../src/simulator';

// The eval suite is part of `pnpm test`, so a change that breaks a safety rule fails CI.
describe('conversation scenarios (scripted planner)', () => {
  for (const scenario of loadScenarios()) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const result = await runScenario(scenario);
      expect(result.failures).toEqual([]);
    });
  }
});
