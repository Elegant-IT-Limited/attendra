// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from './clinic';
import { localParts, toMinutes } from './time';

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
