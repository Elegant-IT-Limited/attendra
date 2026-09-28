import { describe, expect, it } from 'vitest';
import { DEMO_CLINIC, isOpen, localParts, todaysHoursLine, zonedInstant } from '../src';

describe('clinic-local time', () => {
  it('turns a Denver wall-clock time into the right UTC instant, on both sides of DST', () => {
    expect(zonedInstant('2026-07-01', '09:00', 'America/Denver').toISOString()).toBe('2026-07-01T15:00:00.000Z'); // MDT, UTC-6
    expect(zonedInstant('2026-12-01', '09:00', 'America/Denver').toISOString()).toBe('2026-12-01T16:00:00.000Z'); // MST, UTC-7
  });

  it('reads the local date, not the UTC one, late in the evening', () => {
    // 9:30 pm in Denver on Tuesday is already Wednesday in UTC
    expect(localParts(new Date('2026-09-30T03:30:00Z'), 'America/Denver')).toMatchObject({ date: '2026-09-29', weekday: 2 });
  });
});

describe('opening hours', () => {
  it('is open mid-morning, closed over lunch and after hours', () => {
    expect(isOpen(DEMO_CLINIC, zonedInstant('2026-09-29', '10:15', 'America/Denver'))).toBe(true);
    expect(isOpen(DEMO_CLINIC, zonedInstant('2026-09-29', '12:30', 'America/Denver'))).toBe(false);
    expect(isOpen(DEMO_CLINIC, zonedInstant('2026-09-29', '17:00', 'America/Denver'))).toBe(false);
  });

  it('treats a holiday as closed all day and says so', () => {
    const thanksgiving = zonedInstant('2026-11-26', '10:00', 'America/Denver');
    expect(isOpen(DEMO_CLINIC, thanksgiving)).toBe(false);
    expect(todaysHoursLine(DEMO_CLINIC, thanksgiving)).toBe('The clinic is closed today for a holiday.');
  });

  it('describes a split day in one line', () => {
    expect(todaysHoursLine(DEMO_CLINIC, zonedInstant('2026-09-29', '07:00', 'America/Denver')))
      .toBe('Today the clinic is open 08:00 to 12:00 and 13:00 to 17:00.');
  });
});
