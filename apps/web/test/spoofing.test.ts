import { describe, expect, it } from 'vitest';
import { shortFirstCalls, SPOOFED_SIGN } from '../lib/spoofing';

const call = (firstCall: boolean, voiceSeconds: number | null, channel: 'phone' | 'web' = 'phone') => ({ channel, firstCall, voiceSeconds });

describe('the sign that the clinic\'s number is spoofed elsewhere', () => {
  it('counts short first calls from new numbers among the last 30 phone calls, never browser tests or callers who stayed', () => {
    const calls = [
      ...Array.from({ length: 5 }, () => call(true, 8)),
      call(true, 120), call(false, 6), call(true, 0, 'web'), call(true, null),
    ];
    expect(shortFirstCalls(calls)).toBe(6); // the five, and the one with no voice at all
    expect(shortFirstCalls(calls)).toBeGreaterThanOrEqual(SPOOFED_SIGN);
    // only the last 30 phone calls count
    const old = [...Array.from({ length: 30 }, () => call(false, 90)), ...Array.from({ length: 10 }, () => call(true, 5))];
    expect(shortFirstCalls(old)).toBe(0);
  });
});
