// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pieces a spoken date is built from, read with formatToParts in the clinic's zone. Every language builds its words
 * from these numbers, never from a formatted string: what ICU writes ("5:20 PM" with a narrow space, "p. m.") changes
 * with the Node version.
 */
export interface WallClock { date: string; year: number; month: number; day: number; weekday: number; hour: number; minute: number }

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The clinic-local wall clock of an instant: its date, its weekday (0 = Sunday) and its time on the 24-hour clock. */
export function wallClock(start: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(start);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const [year, month, day] = [Number(get('year')), Number(get('month')), Number(get('day'))];
  return { date: `${get('year')}-${get('month')}-${get('day')}`, year, month, day, weekday: WEEKDAY_INDEX[get('weekday')] ?? 0, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

/** A local date (YYYY-MM-DD) as its parts: month 1 to 12, weekday 0 for Sunday. */
export function dateParts(date: string): { year: number; month: number; day: number; weekday: number } {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** 17:20 as 5 and "20" on a 12-hour clock: 0 and 12 are 12. */
export const clock12 = (hour: number, minute: number) => ({ hour: hour % 12 || 12, minutes: String(minute).padStart(2, '0') });
