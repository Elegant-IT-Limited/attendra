import { describe, expect, it } from 'vitest';
import { callerIdOf, callFacts, ClinicConfig, DEMO_CLINIC, openNowLine, todayLine, todaysHoursLine, zonedInstant } from '../src';

// Foundation A, item 5: one call's facts, the same for the planner, gpt-realtime with our tools and Vapi. The demo
// clinic (Denver) is open 08:00 to 12:00 and 13:00 to 17:00 Monday to Thursday, 08:00 to 13:00 on Friday, closed on
// Thanksgiving (2026-11-26). Made-up clinics and numbers.
const tz = DEMO_CLINIC.timezone;

describe('callFacts', () => {
  it('reads the date, the weekday and the time in the clinic\'s own zone, not the server\'s', () => {
    // 05:30 UTC on Tuesday, September 29: still Monday evening in Denver, already Tuesday morning in New York
    const at = new Date('2026-09-29T05:30:00Z');
    const denver = callFacts(DEMO_CLINIC, at, null);
    expect(denver).toMatchObject({ date: '2026-09-28', weekday: 1, dayName: 'Monday', time: '23:30', zoneName: 'MDT', open: false });
    const york = callFacts({ ...DEMO_CLINIC, timezone: 'America/New_York' }, at, null);
    expect(york).toMatchObject({ date: '2026-09-29', weekday: 2, dayName: 'Tuesday', time: '01:30', zoneName: 'EDT', open: false, opensNext: { date: '2026-09-29', time: '08:00' } });
    // the zone's name follows daylight saving time
    expect(callFacts(DEMO_CLINIC, zonedInstant('2026-11-17', '09:00', tz), null).zoneName).toBe('MST');
  });

  it('open now with the closing time, closed over lunch with the opening the same day, and the lines the planner reads', () => {
    const morning = callFacts(DEMO_CLINIC, zonedInstant('2026-09-29', '10:14', tz), null);
    expect(morning).toMatchObject({ open: true, closesAt: '12:00', opensNext: null, holiday: false, holidayToday: false });
    expect(todayLine(morning)).toBe('Today is Tuesday, 2026-09-29, 10:14 clinic time.');
    expect(todaysHoursLine(morning)).toBe('Today the clinic is open 08:00 to 12:00 and 13:00 to 17:00.');
    expect(openNowLine(morning)).toBe('The clinic is open now, until 12:00.');
    const lunch = callFacts(DEMO_CLINIC, zonedInstant('2026-09-29', '12:30', tz), null);
    expect(lunch).toMatchObject({ open: false, closesAt: null, opensNext: { date: '2026-09-29', time: '13:00' } });
    expect(openNowLine(lunch)).toBe('The clinic is closed now; it next opens today at 13:00.');
    // Friday evening: the next opening is Monday's
    const friday = callFacts(DEMO_CLINIC, zonedInstant('2026-10-02', '18:00', tz), null);
    expect(openNowLine(friday)).toBe('The clinic is closed now; it next opens Monday, 2026-10-05 at 08:00.');
  });

  it('a holiday is closed all day, said as a holiday, and the next opening skips it', () => {
    const thanksgiving = callFacts(DEMO_CLINIC, zonedInstant('2026-11-26', '10:00', tz), null);
    expect(thanksgiving).toMatchObject({ open: false, holiday: true, holidayToday: true, specialToday: false, todayHours: [], opensNext: { date: '2026-11-27', time: '08:00' } });
    expect(todaysHoursLine(thanksgiving)).toBe('The clinic is closed today for a holiday.');
    expect(openNowLine(thanksgiving)).toBe('The clinic is closed now; it next opens Friday, 2026-11-27 at 08:00.');
  });

  it('a special day: closed with its note, or shorter hours, by its own windows', () => {
    const shut = ClinicConfig.parse({ ...DEMO_CLINIC, specialDays: [{ date: '2026-09-29', windows: [], note: 'flooding' }] });
    const closed = callFacts(shut, zonedInstant('2026-09-29', '10:00', tz), null);
    expect(closed).toMatchObject({ open: false, holiday: true, holidayToday: false, specialToday: true, specialNote: 'flooding', opensNext: { date: '2026-09-30', time: '08:00' } });
    expect(todaysHoursLine(closed)).toBe('The clinic is closed today (flooding).');
    const short = ClinicConfig.parse({ ...DEMO_CLINIC, specialDays: [{ date: '2026-09-29', windows: [{ open: '09:00', close: '10:00' }], note: 'staff training' }] });
    const before = callFacts(short, zonedInstant('2026-09-29', '08:30', tz), null);
    expect(before).toMatchObject({ open: false, opensNext: { date: '2026-09-29', time: '09:00' } });
    expect(todaysHoursLine(before)).toBe('Today the clinic is open 09:00 to 10:00 (staff training).');
    expect(callFacts(short, zonedInstant('2026-09-29', '09:30', tz), null)).toMatchObject({ open: true, closesAt: '10:00' });
  });

  it('the caller ID as the paths use it: the number and its last four digits, or none', () => {
    expect(callFacts(DEMO_CLINIC, zonedInstant('2026-09-29', '10:00', tz), '+13035550147').caller).toEqual({ number: '+13035550147', last4: '0147' });
    expect(callerIdOf('(303) 555-0182')).toEqual({ number: '(303) 555-0182', last4: '0182' });
    expect(callFacts(DEMO_CLINIC, zonedInstant('2026-09-29', '10:00', tz), null).caller).toBeNull();
    expect(callerIdOf('')).toBeNull();
    expect(callerIdOf(undefined)).toBeNull();
  });
});
