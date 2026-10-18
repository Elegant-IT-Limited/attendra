// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig, EmergencyHospital } from './clinic';
import { type Language, PACKS } from './locales';
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

/**
 * The emergency hospital to send a caller to now: the clinic's choices in order, the
 * first one open at this moment in the clinic's time. Null when none is open, so the
 * script falls back to "the nearest 24-hour emergency vet".
 */
export function hospitalFor(clinic: Pick<ClinicConfig, 'emergencyHospital' | 'moreEmergencyHospitals' | 'timezone'>, at: Date): EmergencyHospital | null {
  const minutes = localParts(at, clinic.timezone).minutes;
  const open = (h: EmergencyHospital) => {
    if (!h.hours) return true;
    const from = toMinutes(h.hours.open);
    const to = toMinutes(h.hours.close);
    return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  };
  return [clinic.emergencyHospital, ...(clinic.moreEmergencyHospitals ?? [])].find((h): h is EmergencyHospital => !!h && open(h)) ?? null;
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
export function hoursSummary(clinic: Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone' | 'phoneNumbers'>, at: Date, language: Language): string {
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
  const soon = clinic.holidays.filter((d) => d >= today && d <= addDays(today, 14)).sort();
  const closed = soon.map((d) => `${days[(weekdayOf(d) + 6) % 7]} ${d.slice(5)}`);
  return [open || '-', ...(closed.length ? [`${language === 'es' ? 'cerrado' : 'closed'} ${closed.join(', ')}`] : [])].join('; ');
}
