// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from './clinic';
import { addDays, localParts, toMinutes, weekdayOf } from './time';

type Hours = ClinicConfig['hours'];

export function windowsOn(hours: Hours, weekday: number) {
  return hours[String(weekday) as keyof Hours] ?? [];
}

/** Open right now, in the clinic's zone, with holidays counted as closed all day. */
export function isOpen(clinic: Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone'>, at: Date): boolean {
  const local = localParts(at, clinic.timezone);
  if (clinic.holidays.includes(local.date)) return false;
  return windowsOn(clinic.hours, local.weekday)
    .some((w) => local.minutes >= toMinutes(w.open) && local.minutes < toMinutes(w.close));
}

/** One short line the voice model can say: "Today we are open 8:00 to 12:00 and 13:00 to 17:00." */
export function todaysHoursLine(clinic: Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone'>, at: Date): string {
  const local = localParts(at, clinic.timezone);
  if (clinic.holidays.includes(local.date)) return 'The clinic is closed today for a holiday.';
  const windows = windowsOn(clinic.hours, local.weekday);
  if (!windows.length) return 'The clinic is closed today.';
  return `Today the clinic is open ${windows.map((w) => `${w.open} to ${w.close}`).join(' and ')}.`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Today is Tuesday, 2026-09-29, 10:14 clinic time." The planner needs it to turn "next week" into a date. */
export function todayLine(clinic: Pick<ClinicConfig, 'timezone'>, at: Date): string {
  const local = localParts(at, clinic.timezone);
  const time = `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`;
  return `Today is ${DAY_NAMES[local.weekday]}, ${local.date}, ${time} clinic time.`;
}

/** The next seven days of opening hours, today first, holidays marked: for "are you open tomorrow?". */
export function weekHours(clinic: Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone'>, at: Date): string {
  const today = localParts(at, clinic.timezone).date;
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i);
    const day = `${DAY_NAMES[weekdayOf(date)]} ${date}`;
    if (clinic.holidays.includes(date)) return `${day}: closed for a holiday`;
    const windows = windowsOn(clinic.hours, weekdayOf(date));
    return `${day}: ${windows.length ? windows.map((w) => `${w.open} to ${w.close}`).join(' and ') : 'closed'}`;
  }).join('; ');
}
