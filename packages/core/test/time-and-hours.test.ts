import { describe, expect, it } from 'vitest';
import { DEMO_CLINIC, demoHolidays, isOpen, localParts, todayLine, todaysHoursLine, weekHours, zonedInstant } from '../src';

describe('clinic-local time', () => {
  it('turns a Denver wall-clock time into the right UTC instant, on both sides of DST', () => {
    expect(zonedInstant('2026-07-01', '09:00', 'America/Denver').toISOString()).toBe('2026-07-01T15:00:00.000Z'); // MDT, UTC-6
    expect(zonedInstant('2026-12-01', '09:00', 'America/Denver').toISOString()).toBe('2026-12-01T16:00:00.000Z'); // MST, UTC-7
  });

  it('starts Havana\'s day at 01:00 on its DST switch day, when midnight does not exist', () => {
    // 2026-03-08: clocks go from 23:59 on the 7th straight to 01:00
    const start = zonedInstant('2026-03-08', '00:00', 'America/Havana');
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(localParts(start, 'America/Havana')).toMatchObject({ date: '2026-03-08', minutes: 60 });
    expect(zonedInstant('2026-03-08', '09:00', 'America/Havana').toISOString()).toBe('2026-03-08T13:00:00.000Z');
    // 2026-11-01: midnight happens twice, and the day starts at the first
    expect(zonedInstant('2026-11-01', '00:00', 'America/Havana').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    // the same rules away from midnight: a skipped time moves past the gap, a repeated one is the earlier
    expect(zonedInstant('2026-03-08', '02:30', 'America/Denver').toISOString()).toBe('2026-03-08T09:30:00.000Z');
    expect(zonedInstant('2026-11-01', '01:30', 'America/Denver').toISOString()).toBe('2026-11-01T07:30:00.000Z');
  });

  it('gives the demo this year\'s and next year\'s Thanksgiving and Christmas, whatever the year', () => {
    expect(demoHolidays(2026)).toEqual(['2026-11-26', '2026-12-25', '2027-11-25', '2027-12-25']);
    expect(demoHolidays(2030)).toEqual(['2030-11-28', '2030-12-25', '2031-11-27', '2031-12-25']);
    expect(DEMO_CLINIC.holidays).toEqual(demoHolidays(new Date().getUTCFullYear()));
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
    const clinic = { ...DEMO_CLINIC, holidays: ['2026-11-26'] };
    const thanksgiving = zonedInstant('2026-11-26', '10:00', 'America/Denver');
    expect(isOpen(clinic, thanksgiving)).toBe(false);
    expect(todaysHoursLine(clinic, thanksgiving)).toBe('The clinic is closed today for a holiday.');
  });

  it('describes a split day in one line', () => {
    expect(todaysHoursLine(DEMO_CLINIC, zonedInstant('2026-09-29', '07:00', 'America/Denver')))
      .toBe('Today the clinic is open 08:00 to 12:00 and 13:00 to 17:00.');
  });
});

describe('the date and the week, for the planner', () => {
  const at = zonedInstant('2026-09-29', '10:14', 'America/Denver');
  it('says what day it is in the clinic', () => {
    expect(todayLine(DEMO_CLINIC, at)).toBe('Today is Tuesday, 2026-09-29, 10:14 clinic time.');
  });
  it('lists seven days from today, weekends closed', () => {
    const week = weekHours(DEMO_CLINIC, at).split('; ');
    expect(week).toHaveLength(7);
    expect(week[0]).toMatch(/^Tuesday 2026-09-29: \d/);
    expect(week[4]).toBe('Saturday 2026-10-03: closed');
  });
});
