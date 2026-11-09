import { describe, expect, it } from 'vitest';
import { limitIsTimeLeft, minutesText, testCallLimitLabel, testTimeLeft, testTimeLeftLine } from '../lib/test-call-limit';

describe('the test-call limit shown before the call', () => {
  it('says the limit for one call when the clinic has as much left, or no limit', () => {
    expect(testCallLimitLabel({ perCallSeconds: 900, callSeconds: 900 })).toBe('One test call can last up to 15 minutes');
    expect(testCallLimitLabel({ perCallSeconds: 600, callSeconds: 600 })).toBe('One test call can last up to 10 minutes');
  });

  it('says the time left when it is less than one call', () => {
    expect(testCallLimitLabel({ perCallSeconds: 900, callSeconds: 450 })).toBe('Test calls: 7 min 30 s left');
    expect(testCallLimitLabel({ perCallSeconds: 900, callSeconds: 61 })).toBe('Test calls: 1 min 1 s left');
    expect(testCallLimitLabel({ perCallSeconds: 900, callSeconds: 30 })).toBe('Test calls: 30 s left');
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

describe('the test-call time left, one way everywhere', () => {
  it('writes minutes and seconds in words, not a clock', () => {
    expect(testTimeLeft(128 * 60 + 41)).toBe('128 min 41 s left');
    expect(testTimeLeft(15 * 60)).toBe('15 min left');
    expect(testTimeLeft(41)).toBe('41 s left');
    expect(testTimeLeft(0)).toBe('0 s left');
    expect(testTimeLeft(59.9)).toBe('59 s left');
    expect(testTimeLeftLine(128 * 60 + 41)).toBe('Test calls: 128 min 41 s left');
    expect(testTimeLeftLine(0)).toBe('No test-call time left.');
    // the label before a call and the line under it say the same number the same way
    expect(testCallLimitLabel({ perCallSeconds: 900, callSeconds: 450 })).toBe(testTimeLeftLine(450));
  });
});
