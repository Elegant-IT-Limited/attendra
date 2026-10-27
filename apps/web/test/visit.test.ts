import { describe, expect, it } from 'vitest';
import { offersChanges } from '../lib/visit';

describe('what a visit\'s panel offers', () => {
  const now = new Date('2026-11-03T17:00:00Z');
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

  it('offers changes for a booked visit still ahead, and none once it has started', () => {
    expect(offersChanges({ status: 'booked', startsAt: at(10) }, now, false)).toBe(true);
    expect(offersChanges({ status: 'booked', startsAt: at(-1) }, now, false)).toBe(false);
  });

  it('keeps the buttons of a move or cancel begun before the start passed', () => {
    expect(offersChanges({ status: 'booked', startsAt: at(-1) }, now, true)).toBe(true);
  });

  it('never for a cancelled visit', () => {
    expect(offersChanges({ status: 'cancelled', startsAt: at(60) }, now, false)).toBe(false);
    expect(offersChanges({ status: 'cancelled', startsAt: at(60) }, now, true)).toBe(false);
  });
});
