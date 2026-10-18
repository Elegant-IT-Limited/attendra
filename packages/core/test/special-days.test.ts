import { describe, expect, it } from 'vitest';
import { ClinicConfig, DEMO_CLINIC, findSlots, hoursSummary, isOpen, speakSlot, todaysHoursLine, weekHours, zonedInstant } from '../src';

const tz = DEMO_CLINIC.timezone;
const sick = DEMO_CLINIC.visitTypes.find((v) => v.id === 'vt_sick')!;
const okafor = DEMO_CLINIC.providers.find((p) => p.id === 'prov_okafor')!;
const now = zonedInstant('2026-09-28', '20:00', tz); // Monday evening
const at = (date: string, time: string) => zonedInstant(date, time, tz);
const slots = (clinic: Parameters<typeof findSlots>[0], providers = [okafor], from = '2026-09-29') =>
  findSlots(clinic, [], { visitType: sick, providers, from, days: 1, now, limit: 50 }).map((s) => speakSlot(s.start, tz).replace(/^.* at /, ''));

describe('special days', () => {
  const short = { ...DEMO_CLINIC, specialDays: [{ date: '2026-09-29', windows: [{ open: '09:00', close: '10:00' }], note: 'staff training' }] };
  const shut = { ...DEMO_CLINIC, specialDays: [{ date: '2026-09-29', windows: [], note: 'flooding' }] };

  it('uses the day\'s own hours: open, the line the assistant says, the week', () => {
    expect(isOpen(short, at('2026-09-29', '09:30'))).toBe(true);
    expect(isOpen(short, at('2026-09-29', '11:00'))).toBe(false);
    expect(todaysHoursLine(short, at('2026-09-29', '08:00'))).toBe('Today the clinic is open 09:00 to 10:00 (staff training).');
    expect(todaysHoursLine(shut, at('2026-09-29', '08:00'))).toBe('The clinic is closed today (flooding).');
    expect(weekHours(short, now).split('; ')[1]).toBe('Tuesday 2026-09-29: 09:00 to 10:00 (staff training)');
  });

  it('offers only the special day\'s times, and none when it is closed', () => {
    expect(slots(short)).toEqual(['9:00 AM', '9:20 AM', '9:40 AM']);
    expect(slots(shut)).toEqual([]);
  });

  it('keeps a provider\'s own hours inside the clinic\'s for that date', () => {
    const lindqvist = DEMO_CLINIC.providers.find((p) => p.id === 'prov_lindqvist')!; // 9:00 to 15:00 on Tuesdays
    const late = { ...DEMO_CLINIC, specialDays: [{ date: '2026-09-29', windows: [{ open: '08:00', close: '09:40' }] }] };
    expect(slots(late, [lindqvist])).toEqual(['9:00 AM', '9:20 AM']);
  });

  it('names shorter and closed special days in the hours line for a text', () => {
    const line = hoursSummary({ ...short, specialDays: [...short.specialDays, { date: '2026-10-01', windows: [] }] }, now, 'en');
    expect(line).toContain('Tue 09-29 9 AM–10 AM');
    expect(line).toContain('closed Thu 10-01');
  });

  it('refuses a date that is a holiday and a special day, a backwards window and a date twice', () => {
    const bad = (specialDays: unknown[], holidays: string[] = []) => ClinicConfig.safeParse({ ...DEMO_CLINIC, holidays, specialDays }).success;
    expect(bad([{ date: '2026-09-29', windows: [] }], ['2026-09-29'])).toBe(false);
    expect(bad([{ date: '2026-09-29', windows: [{ open: '10:00', close: '09:00' }] }])).toBe(false);
    expect(bad([{ date: '2026-09-29', windows: [] }, { date: '2026-09-29', windows: [] }])).toBe(false);
    expect(bad([{ date: '2026-09-29', windows: [{ open: '09:00', close: '10:00' }] }])).toBe(true);
  });
});

describe('time off for part of a day', () => {
  const away = (timeOff: unknown[]) => ({ ...okafor, timeOff: timeOff as typeof okafor.timeOff });

  it('skips only the times that overlap it', () => {
    const offered = slots(DEMO_CLINIC, [away([{ from: '2026-09-29', to: '2026-09-29', start: '08:30', end: '11:00' }])]);
    expect(offered.slice(0, 3)).toEqual(['8:00 AM', '11:00 AM', '11:20 AM']);
  });

  it('a whole day off still takes the whole day', () => {
    expect(slots(DEMO_CLINIC, [away([{ from: '2026-09-29', to: '2026-09-29' }])])).toEqual([]);
  });

  it('is one day, with a start before its end', () => {
    const ok = (t: unknown) => ClinicConfig.safeParse({ ...DEMO_CLINIC, providers: [{ ...okafor, timeOff: [t] }, ...DEMO_CLINIC.providers.slice(1)] }).success;
    expect(ok({ from: '2026-09-29', to: '2026-09-30', start: '08:30', end: '11:00' })).toBe(false);
    expect(ok({ from: '2026-09-29', to: '2026-09-29', start: '11:00', end: '08:30' })).toBe(false);
    expect(ok({ from: '2026-09-29', to: '2026-09-29', start: '08:30' })).toBe(false);
    expect(ok({ from: '2026-09-29', to: '2026-09-29', start: '08:30', end: '11:00' })).toBe(true);
  });
});
