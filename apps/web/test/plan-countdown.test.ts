import { describe, expect, it } from 'vitest';
import { daysLeft } from '../lib/format';

describe('trial countdown', () => {
  it('counts part of a day as a day, and nothing once the trial has ended', () => {
    const now = Date.parse('2026-10-20T15:00:00Z');
    expect(daysLeft('2026-11-03T15:00:00Z', now)).toBe(14);
    expect(daysLeft('2026-10-21T09:00:00Z', now)).toBe(1);
    expect(daysLeft('2026-10-20T14:00:00Z', now)).toBe(0);
  });
});
