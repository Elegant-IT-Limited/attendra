import { describe, expect, it } from 'vitest';
import { withoutDoneCheck } from '../src/confirmation';

describe('withoutDoneCheck', () => {
  it('drops a check that the change is done and trims what is left', () => {
    expect(withoutDoneCheck('yes, is it booked now?')).toBe('yes');
    expect(withoutDoneCheck(' , okay ; ')).toBe('okay');
  });

  it('stays fast on a long run of spaces (no regex backtracking: CodeQL js/polynomial-redos)', () => {
    const started = Date.now();
    expect(withoutDoneCheck(`a${' '.repeat(40_000)}b`)).toBe('a b');
    expect(Date.now() - started).toBeLessThan(200);
  });
});
