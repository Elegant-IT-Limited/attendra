// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from './clinic';
import { specialDayOf, windowsOnDate } from './hours';
import type { Language } from './locales';
import { addDays, localParts, toMinutes, zonedInstant } from './time';

type Days = Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone' | 'afterHours'> & { specialDays?: ClinicConfig['specialDays'] };

/**
 * The clinic's clock, as the one source every engine and every tool reads (`clinic_now`): the local date and time with
 * its zone, whether the front desk is open, when it closes or next opens, and what the assistant does with a visit right
 * now. Nothing here is baked into a voice prompt: a prompt written at the start of a call was still saying "closed" an
 * hour after the clinic opened, and the voice refused a booking at 7:25 AM at a clinic that books after hours (2026-11).
 */
export interface ClinicNow {
  /** The clinic's local date (YYYY-MM-DD), weekday (0 Sunday) and time of day (HH:MM, 24-hour). */
  date: string;
  weekday: number;
  time: string;
  /** The IANA zone and its short name now ("EST", "GMT-5"). */
  zone: string;
  zoneName: string;
  /** For the greeting and the goodbye: "good morning" before noon, "good afternoon" to 6 PM, else "good evening". */
  partOfDay: 'morning' | 'afternoon' | 'evening';
  open: boolean;
  /** Today's closing time while open; null when closed. */
  closesAt: string | null;
  /** When the front desk next opens, while closed, within two weeks; null while open or when no opening is set. */
  opensNext: { date: string; time: string } | null;
  /** Today is a holiday, or a special day: its note ("staff training"), when it has one. */
  holiday: boolean;
  specialNote: string | null;
  /** The clinic's after-hours setting, and what it means now: a visit is booked on the call, or taken as a request for the team. */
  afterHours: 'book' | 'requests';
  visitsNow: 'book' | 'request';
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The clinic's clock at one moment. */
export function clinicNow(clinic: Days, at: Date): ClinicNow {
  const local = localParts(at, clinic.timezone);
  const windows = windowsOnDate(clinic, local.date);
  const current = windows.find((w) => local.minutes >= toMinutes(w.open) && local.minutes < toMinutes(w.close));
  const special = specialDayOf(clinic, local.date);
  const open = !!current;
  let opensNext: ClinicNow['opensNext'] = null;
  if (!open) {
    for (let i = 0; i < 14 && !opensNext; i++) {
      const date = addDays(local.date, i);
      const next = windowsOnDate(clinic, date).find((w) => i > 0 || toMinutes(w.open) > local.minutes);
      if (next) opensNext = { date, time: next.open };
    }
  }
  const zoneName = new Intl.DateTimeFormat('en-US', { timeZone: clinic.timezone, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? clinic.timezone;
  const afterHours = clinic.afterHours ?? 'book';
  return {
    date: local.date, weekday: local.weekday, time: hhmm(local.minutes), zone: clinic.timezone, zoneName,
    partOfDay: local.minutes < 12 * 60 ? 'morning' : local.minutes < 18 * 60 ? 'afternoon' : 'evening',
    open, closesAt: current?.close ?? null, opensNext,
    holiday: special ? !special.windows.length : clinic.holidays.includes(local.date),
    specialNote: special?.note ?? null,
    afterHours,
    visitsNow: open || afterHours === 'book' ? 'book' : 'request',
  };
}

const LOCALE: Record<Language, string> = { en: 'en-US', es: 'es-US' };

/** A clock time said the way people say it: "7:25 AM", "las 7:25 a. m.". */
function spokenClock(clinic: Pick<ClinicConfig, 'timezone'>, date: string, time: string, lang: Language) {
  return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: clinic.timezone, hour: 'numeric', minute: '2-digit' }).format(zonedInstant(date, time, clinic.timezone));
}
function spokenDay(clinic: Pick<ClinicConfig, 'timezone'>, date: string, lang: Language) {
  return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: clinic.timezone, weekday: 'long', month: 'long', day: 'numeric' }).format(zonedInstant(date, '12:00', clinic.timezone));
}

/**
 * The clock as the voice says it, in the call's language: the time with its zone, open or when it opens, and whether a
 * visit is booked now. One short paragraph; the facts are the same ones `clinicNow` returns.
 */
export function clinicNowLine(clinic: Days, now: ClinicNow, lang: Language): string {
  const time = spokenClock(clinic, now.date, now.time, lang);
  const day = spokenDay(clinic, now.date, lang);
  const next = now.opensNext;
  const sameDay = next?.date === now.date;
  const closes = now.closesAt ? spokenClock(clinic, now.date, now.closesAt, lang) : null;
  // "p. m." already ends in a full stop: a sentence never ends in two
  const end = (s: string) => (s.endsWith('.') ? s : `${s}.`);
  if (lang === 'es') {
    const opens = next ? `; abre a las ${spokenClock(clinic, next.date, next.time, lang)}${sameDay ? '' : ` del ${spokenDay(clinic, next.date, lang)}`}` : '';
    return [
      `Son las ${time} del ${day}, hora de la clínica (${now.zoneName}).`,
      now.open ? end(`La clínica está abierta hasta las ${closes}`) : end(`La clínica está cerrada${now.specialNote ? ` (${now.specialNote})` : ''}${opens}`),
      now.visitsNow === 'book' ? (now.open ? '' : 'Igual se pueden reservar citas por teléfono ahora.') : 'Ahora no se reservan citas: se toma una solicitud para que el equipo llame.',
    ].filter(Boolean).join(' ');
  }
  const opens = next ? `; it opens at ${spokenClock(clinic, next.date, next.time, lang)}${sameDay ? '' : ` on ${spokenDay(clinic, next.date, lang)}`}` : '';
  return [
    `It's ${time} on ${day}, clinic time (${now.zoneName}).`,
    now.open ? end(`The clinic is open until ${closes}`) : end(`The clinic is closed${now.specialNote ? ` (${now.specialNote})` : ''}${opens}`),
    now.visitsNow === 'book' ? (now.open ? '' : 'Visits can still be booked on this call now.') : 'Visits are not booked right now: a request is taken for the team to call back.',
  ].filter(Boolean).join(' ');
}
