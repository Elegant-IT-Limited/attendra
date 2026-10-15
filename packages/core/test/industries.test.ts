import { describe, expect, it } from 'vitest';
import { ClinicConfig, DEMO_CLINIC, INDUSTRIES, INDUSTRY_PACKS, industryPack } from '../src';

describe('industry packs', () => {
  it('gives every account the clinic pack unless it says otherwise', () => {
    expect(ClinicConfig.parse({ ...DEMO_CLINIC, industry: undefined }).industry).toBe('clinic');
    expect(industryPack(undefined).id).toBe('clinic');
    expect(industryPack('no-such-trade').id).toBe('clinic');
  });

  it('refuses an industry that has no pack', () => {
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, industry: 'no-such-trade' }).success).toBe(false);
  });

  it('names every term and fills every prompt slot in every pack', () => {
    for (const id of INDUSTRIES) {
      const pack = INDUSTRY_PACKS[id];
      expect(pack.id).toBe(id);
      for (const word of Object.values(pack.terms)) expect(word).toMatch(/^[a-z][a-z ]*$/);
      for (const lines of Object.values(pack.prompt)) for (const line of lines) expect(line.trim().length).toBeGreaterThan(10);
    }
  });
});
