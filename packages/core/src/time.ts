// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Time zone arithmetic without a date library. Every rule in this package works on
 * the clinic's local wall clock, because "we open at 8" means 8 in Denver, not 8 UTC.
 */

export interface LocalParts {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since local midnight
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/**
 * The UTC instant for a local date and "HH:MM" in a zone. Solved by guessing the
 * offset and correcting once, which also lands correctly on either side of a DST
 * change (a time that does not exist in spring resolves to the hour after).
 */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone);
    const [gy, gm, gd] = p.date.split('-').map(Number) as [number, number, number];
    const seen = Date.UTC(gy, gm - 1, gd) + p.minutes * 60_000;
    guess += wanted - seen;
  }
  return new Date(guess);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

export const fromMinutes = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
