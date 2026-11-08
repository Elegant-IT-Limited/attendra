// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig, EmergencyHospital } from './clinic';
import { type Language, PACKS } from './locales';
import { addDays, fromMinutes, localParts, toMinutes, weekdayOf } from './time';

type Hours = ClinicConfig['hours'];

export function windowsOn(hours: Hours, weekday: number) {
  return hours[String(weekday) as keyof Hours] ?? [];
}

type Days = Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone'> & { specialDays?: ClinicConfig['specialDays'] };

/** A date's own hours, when the clinic set some: a half day, or closed with a reason. */
export const specialDayOf = (clinic: Pick<ClinicConfig, 'specialDays'>, date: string) => clinic.specialDays?.find((d) => d.date === date);

/** The clinic's hours on one date: a special day's own, none on a holiday, else the week's. */
export function windowsOnDate(clinic: Days, date: string) {
  const special = specialDayOf(clinic, date);
  if (special) return special.windows;
  if (clinic.holidays.includes(date)) return [];
  return windowsOn(clinic.hours, weekdayOf(date));
}

type Window = { open: string; close: string };

/** The weekly hours a provider is booked by: their own when they have some, else the clinic's. */
export const ownHours = (clinic: Pick<ClinicConfig, 'hours'>, provider: { hours?: Hours | undefined }): Hours => provider.hours ?? clinic.hours;

/**
 * When one provider can be seen on one date, and the clinic's own hours that date, for every surface that books or
 * shows a time (the assistant, the desk's checks, the booking dialog, the schedule grid, the hours the assistant
 * says). A provider's own hours decide, even outside the clinic's (a Sunday-only vet, a vet in until 7 at a clinic
 * that closes at 5); the clinic's hours are for providers with none of their own. A holiday, or a special day, still
 * closes the clinic for everyone, except for a provider the special day lists. A special day with shorter hours keeps
 * a provider with their own hours inside them. Time off is not counted here (awayOn, awayWindows).
 */
export function bookableWindows(clinic: Days, provider: { id: string; hours?: Hours | undefined }, date: string): { windows: Window[]; clinicWindows: Window[] } {
  const weekday = weekdayOf(date);
  const clinicWindows = windowsOnDate(clinic, date);
  const special = specialDayOf(clinic, date);
  if (special?.providerIds?.includes(provider.id)) return { windows: windowsOn(ownHours(clinic, provider), weekday), clinicWindows };
  if (special) return { windows: provider.hours && special.windows.length ? intersectWindows(windowsOn(provider.hours, weekday), special.windows) : special.windows, clinicWindows };
  if (clinic.holidays.includes(date)) return { windows: [], clinicWindows };
  return { windows: windowsOn(ownHours(clinic, provider), weekday), clinicWindows };
}

/** The parts of two lists of windows that overlap. */
export function intersectWindows(a: Window[], b: Window[]): Window[] {
  const out: Window[] = [];
  for (const x of a) for (const y of b) {
    const open = Math.max(toMinutes(x.open), toMinutes(y.open));
    const close = Math.min(toMinutes(x.close), toMinutes(y.close));
    if (open < close) out.push({ open: fromMinutes(open), close: fromMinutes(close) });
  }
  return out;
}

/** Whether a local time of day (minutes) falls while the clinic's front desk is open: inside one of its windows. */
export const insideWindows = (windows: Window[], minutes: number) => windows.some((w) => minutes >= toMinutes(w.open) && minutes < toMinutes(w.close));

/** Settings, a vet's own hours: what those hours mean, in the dashboard's languages. */
export const OWN_HOURS_NOTE = {
  en: 'Hours outside the clinic\'s hours are bookable for this vet.',
  es: 'Las horas fuera del horario de la clínica se pueden reservar con este veterinario.',
} as const;

/** Open right now, in the clinic's zone, with holidays counted as closed all day and special days by their own hours. */
export function isOpen(clinic: Days, at: Date): boolean {
  const local = localParts(at, clinic.timezone);
  return windowsOnDate(clinic, local.date)
    .some((w) => local.minutes >= toMinutes(w.open) && local.minutes < toMinutes(w.close));
}

/**
 * Minutes the clinic was open between two moments, counted in 15-minute steps (each step
 * counts when the clinic is open at its start), for at most 7 days: enough to tell a line
 * that went quiet while open from one that was closed.
 */
export function openMinutes(clinic: Days, from: Date, to: Date, stepMinutes = 15): number {
  const step = stepMinutes * 60_000;
  const end = Math.min(to.getTime(), from.getTime() + 7 * 86_400_000);
  let open = 0;
  for (let t = from.getTime(); t < end; t += step) if (isOpen(clinic, new Date(t))) open += stepMinutes;
  return open;
}

/** One short line the voice model can say: "Today we are open 8:00 to 12:00 and 13:00 to 17:00." */
export function todaysHoursLine(clinic: Days, at: Date): string {
  const local = localParts(at, clinic.timezone);
  const special = specialDayOf(clinic, local.date);
  const why = special?.note ? ` (${special.note})` : '';
  if (!special && clinic.holidays.includes(local.date)) return 'The clinic is closed today for a holiday.';
  const windows = windowsOnDate(clinic, local.date);
  if (!windows.length) return `The clinic is closed today${why}.`;
  return `Today the clinic is open ${windows.map((w) => `${w.open} to ${w.close}`).join(' and ')}${why}.`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Today is Tuesday, 2026-09-29, 10:14 clinic time." The planner needs it to turn "next week" into a date. */
export function todayLine(clinic: Pick<ClinicConfig, 'timezone'>, at: Date): string {
  const local = localParts(at, clinic.timezone);
  const time = `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`;
  return `Today is ${DAY_NAMES[local.weekday]}, ${local.date}, ${time} clinic time.`;
}

/** The next seven days of opening hours, today first, holidays marked: for "are you open tomorrow?". */
export function weekHours(clinic: Days, at: Date): string {
  const today = localParts(at, clinic.timezone).date;
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i);
    const day = `${DAY_NAMES[weekdayOf(date)]} ${date}`;
    const special = specialDayOf(clinic, date);
    if (!special && clinic.holidays.includes(date)) return `${day}: closed for a holiday`;
    const windows = windowsOnDate(clinic, date);
    const why = special?.note ? ` (${special.note})` : special ? ' (special hours)' : '';
    return `${day}: ${windows.length ? windows.map((w) => `${w.open} to ${w.close}`).join(' and ') : 'closed'}${why}`;
  }).join('; ');
}

/**
 * The first of these hospitals (the clinic's choices, in order) that is open at this moment in the clinic's time. Null
 * when none is open, so the script falls back to "the nearest 24-hour emergency vet". A hospital without hours is open
 * around the clock; a close earlier than the open runs past midnight.
 */
export function firstOpenHospital(hospitals: readonly EmergencyHospital[], timezone: string, at: Date): EmergencyHospital | null {
  const minutes = localParts(at, timezone).minutes;
  const open = (h: EmergencyHospital) => {
    if (!h.hours) return true;
    const from = toMinutes(h.hours.open);
    const to = toMinutes(h.hours.close);
    return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  };
  return hospitals.find(open) ?? null;
}

/** "8 AM" or "5:30 PM" in North America, "08:00" elsewhere. */
function clockText(hhmm: string, twelveHour: boolean) {
  if (!twelveHour) return hhmm;
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * The weekly hours in one short line for a text, days with the same hours run
 * together, Monday first: "Mon–Fri 8 AM–5 PM, Sat 9 AM–12 PM; closed Oct 22". The
 * holidays in the next two weeks are added at the end.
 */
export function hoursSummary(clinic: Days & Pick<ClinicConfig, 'phoneNumbers'>, at: Date, language: Language): string {
  const twelve = (clinic.phoneNumbers[0] ?? '').startsWith('+1');
  const days = PACKS[language].shortDays;
  const line = (weekday: number) => windowsOn(clinic.hours, weekday).map((w) => `${clockText(w.open, twelve)}–${clockText(w.close, twelve)}`).join(', ');
  // Monday (1) to Sunday (0)
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups: { from: number; to: number; text: string }[] = [];
  order.forEach((weekday, i) => {
    const text = line(weekday);
    const last = groups.at(-1);
    if (text && last && last.text === text && last.to === i - 1) last.to = i;
    else if (text) groups.push({ from: i, to: i, text });
  });
  const open = groups.map((g) => `${g.from === g.to ? days[g.from] : `${days[g.from]}–${days[g.to]}`} ${g.text}`).join(', ');
  const today = localParts(at, clinic.timezone).date;
  const inTwoWeeks = (d: string) => d >= today && d <= addDays(today, 14);
  const dayName = (d: string) => `${days[(weekdayOf(d) + 6) % 7]} ${d.slice(5)}`;
  const closedDays = [...clinic.holidays, ...(clinic.specialDays ?? []).filter((s) => !s.windows.length).map((s) => s.date)].filter(inTwoWeeks).sort();
  const closed = [...new Set(closedDays)].map(dayName);
  const shorter = (clinic.specialDays ?? []).filter((s) => s.windows.length && inTwoWeeks(s.date)).sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => `${dayName(s.date)} ${s.windows.map((w) => `${clockText(w.open, twelve)}–${clockText(w.close, twelve)}`).join(', ')}`);
  return [open || '-', ...(shorter.length ? [shorter.join(', ')] : []), ...(closed.length ? [`${language === 'es' ? 'cerrado' : 'closed'} ${closed.join(', ')}`] : [])].join('; ');
}
