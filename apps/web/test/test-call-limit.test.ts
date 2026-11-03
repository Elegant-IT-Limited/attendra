import { describe, expect, it } from 'vitest';
import { limitIsTimeLeft, minutesText, testCallLimitLabel } from '../lib/test-call-limit';

describe('the test-call limit shown before the call', () => {
  it('says the limit for one call when the clinic has as much left, or no limit', () => {
    expect(testCallLimitLabel({ perCallSeconds: 900, callSeconds: 900 })).toBe('One test call can last up to 15 minutes');
    expect(testCallLimitLabel({ perCallSeconds: 600, callSeconds: 600 })).toBe('One test call can last up to 10 minutes');
  });

  it('says the time left when it is less than one call', () => {
    expect(testCallLimitLabel({ perCallSeconds: 900, callSeconds: 450 })).toBe('You have 7 minutes of test calls left');
    expect(testCallLimitLabel({ perCallSeconds: 900, callSeconds: 61 })).toBe('You have 1 minute of test calls left');
    expect(testCallLimitLabel({ perCallSeconds: 900, callSeconds: 30 })).toBe('You have less than a minute of test calls left');
    expect(limitIsTimeLeft({ perCallSeconds: 900, callSeconds: 450 })).toBe(true);
    expect(limitIsTimeLeft({ perCallSeconds: 900, callSeconds: 900 })).toBe(false);
  });

  it('says no number when the voice service could not say its limit, or before the answer', () => {
    expect(testCallLimitLabel({ perCallSeconds: null, callSeconds: null })).toBe('A test call stops on its own at its time limit.');
    expect(testCallLimitLabel(undefined)).toBe('A test call stops on its own at its time limit.');
    expect(limitIsTimeLeft(undefined)).toBe(false);
  });

  it('rounds down, so it never promises more than the server gives', () => {
    expect(minutesText(899)).toBe('14 minutes');
    expect(minutesText(60)).toBe('1 minute');
    expect(minutesText(59)).toBe('less than a minute');
  });
});
