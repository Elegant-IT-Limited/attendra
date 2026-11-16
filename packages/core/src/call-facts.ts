// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from './clinic';
import { type ClinicNow, clinicNow } from './clinic-now';
import { specialDayOf, windowsOnDate } from './hours';
import { lastFour } from './routing';
import { weekdayOf } from './time';

type Days = Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone' | 'afterHours'> & { specialDays?: ClinicConfig['specialDays'] };

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The caller ID as every call path uses it: the number the call came from and its last four digits; null without one. */
export interface CallerId { number: string; last4: string }

/** The caller ID of a call, or null on a call without one (a browser test call, a hidden number). */
export function callerIdOf(number: string | null | undefined): CallerId | null {
  if (!number) return null;
  return { number, last4: lastFour(number) };
}

/**
 * One call's own facts, built once and the same on every call path (the planner, gpt-realtime with our tools, Vapi):
 * the clinic's date and weekday, its local time, whether it is open now and when it next opens (clinicNow, the clock
 * clinic_now answers from), today's hours, and the caller ID. Each path says them in its own words, but none works them
 * out by itself: the Vapi path once had no date at all (V1, 2026-11-09) because each path built its own.
 */
export interface CallFacts extends ClinicNow {
  /** The weekday in English ("Tuesday"), for the lines the models read. */
  dayName: string;
  /** Today's opening hours: a special day's own, none on a holiday or a closed day, else the week's. */
  todayHours: { open: string; close: string }[];
  /** Today is one of the clinic's holidays, not a special day (a special day says its own note). */
  holidayToday: boolean;
  /** Today is a special day the clinic set (its own hours, or closed), with or without a note. */
  specialToday: boolean;
  caller: CallerId | null;
}

/** The facts of a call at one moment: the clinic's clock (its own zone, holidays and special days) and the caller ID. */
export function callFacts(clinic: Days, now: Date, caller: string | null | undefined): CallFacts {
  const clock = clinicNow(clinic, now);
  const special = specialDayOf(clinic, clock.date);
  return {
    ...clock,
    dayName: DAY_NAMES[clock.weekday]!,
    todayHours: windowsOnDate(clinic, clock.date),
    holidayToday: !special && clinic.holidays.includes(clock.date),
    specialToday: !!special,
    caller: callerIdOf(caller),
  };
}

/** "Today is Tuesday, 2026-09-29, 10:14 clinic time." The planner needs it to turn "next week" into a date. */
export function todayLine(facts: CallFacts): string {
  return `Today is ${facts.dayName}, ${facts.date}, ${facts.time} clinic time.`;
}

/** One short line of today's hours: "Today the clinic is open 08:00 to 12:00 and 13:00 to 17:00." */
export function todaysHoursLine(facts: CallFacts): string {
  const why = facts.specialNote ? ` (${facts.specialNote})` : '';
  if (facts.holidayToday) return 'The clinic is closed today for a holiday.';
  if (!facts.todayHours.length) return `The clinic is closed today${why}.`;
  return `Today the clinic is open ${facts.todayHours.map((w) => `${w.open} to ${w.close}`).join(' and ')}${why}.`;
}

/**
 * Open or closed at this moment, and when it next opens: "The clinic is open now, until 18:00." or "The clinic is
 * closed now; it next opens Wednesday, 2026-09-30 at 08:00."
 */
export function openNowLine(facts: CallFacts): string {
  if (facts.open) return `The clinic is open now${facts.closesAt ? `, until ${facts.closesAt}` : ''}.`;
  const next = facts.opensNext;
  const when = next ? (next.date === facts.date ? `today at ${next.time}` : `${DAY_NAMES[weekdayOf(next.date)]}, ${next.date} at ${next.time}`) : null;
  return `The clinic is closed now${when ? `; it next opens ${when}` : ''}.`;
}
