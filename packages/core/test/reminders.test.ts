// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { inQuietHours, reminderDecision, reminderSkipLine, spanWords } from '../src/reminders';

const H = 3_600_000;
const now = new Date('2026-11-16T19:30:00Z');
const facts = (startsInH: number, bookedHBefore: number, o: Partial<Parameters<typeof reminderDecision>[0]> = {}) => ({
  now, startsAt: new Date(now.getTime() + startsInH * H), bookedAt: new Date(now.getTime() + (startsInH - bookedHBefore) * H),
  hoursBefore: 2, quietNow: false, consent: true, phone: true, ...o,
});

describe('reminderDecision (texts polish TX0)', () => {
  it('sends as soon as the visit is inside the hours before it, down to an hour away', () => {
    expect(reminderDecision(facts(2, 2.1))).toEqual({ action: 'send' });
    expect(reminderDecision(facts(1.05, 3))).toEqual({ action: 'send' });
    expect(reminderDecision(facts(3, 5))).toEqual({ action: 'later', dueAt: new Date(now.getTime() + H) });
  });
  it('a visit booked under an hour before gets none, and says so', () => {
    expect(reminderDecision(facts(40 / 60, 40 / 60))).toEqual({ action: 'skip', reason: 'booked_late', final: true });
    expect(reminderSkipLine('booked_late', { startsAt: new Date(now.getTime() + 40 * 60_000), bookedAt: now, final: true })).toBe('No reminder: booked 40 minutes before the visit.');
  });
  it('holds for consent, a number or quiet hours while there is time, then keeps the reason', () => {
    expect(reminderDecision(facts(1.5, 5, { consent: false }))).toEqual({ action: 'skip', reason: 'no_consent', final: false });
    expect(reminderDecision(facts(1.5, 5, { quietNow: true }))).toEqual({ action: 'skip', reason: 'quiet_hours', final: false });
    expect(reminderDecision(facts(0.5, 5, { kept: 'quiet_hours' }))).toEqual({ action: 'skip', reason: 'quiet_hours', final: true });
    expect(reminderDecision(facts(0.5, 5))).toEqual({ action: 'skip', reason: 'too_late', final: true });
  });
  it('words a span of time and knows quiet hours past midnight', () => {
    expect([spanWords(40 * 60_000), spanWords(H), spanWords(2 * H + 5 * 60_000)]).toEqual(['40 minutes', '1 hour', '2 hours 5 minutes']);
    expect([inQuietHours(21 * 60, '20:00', '08:00'), inQuietHours(8 * 60, '20:00', '08:00'), inQuietHours(600, '09:00', '09:00')]).toEqual([true, false, false]);
  });
});
