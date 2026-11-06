import { describe, expect, it } from 'vitest';
import { testCallsLeftOut } from '../lib/quality';

describe('the Quality page\'s line about test calls', () => {
  it('says how many were left out, singular or plural, and nothing when there were none', () => {
    expect(testCallsLeftOut(0)).toBeNull();
    expect(testCallsLeftOut(1)).toBe('1 browser test call this week is left out. Quality counts real phone calls only.');
    expect(testCallsLeftOut(3)).toBe('3 browser test calls this week are left out. Quality counts real phone calls only.');
  });
});
