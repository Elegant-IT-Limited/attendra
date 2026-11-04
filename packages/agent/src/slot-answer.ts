// SPDX-License-Identifier: AGPL-3.0-only
import {
  addDays, awayOn, bookableProviders, bookableWindows, type ClinicConfig, type Language, localDateOf, localName, localParts, PACKS, type Provider,
  providerName, type Slot, specialDayOf, toMinutes, weekdayOf, windowsOn, ownHours, type VisitType,
} from '@attendra/core';

/**
 * Why find_slots found nothing on the day (or with the vet) the caller asked for, as a code and the line to say
 * (2026-11-15: "fully booked for two weeks" was really a vet who does not do that visit). Codes:
 * doesnt_do_type, not_working_that_day, clinic_closed, notice, fully_booked, too_far_ahead.
 */
export type SlotReason = 'doesnt_do_type' | 'not_working_that_day' | 'clinic_closed' | 'notice' | 'fully_booked' | 'too_far_ahead';

const clock = (minutes: number) => ({ hour: Math.floor(minutes / 60), minute: minutes % 60 });
const pronounOf = (p: Pick<Provider, 'gender'>) => (p.gender === 'female' || p.gender === 'male' ? p.gender : null);
const nameIn = (p: Provider, lang: Language) => providerName(p, lang);

/** The vet asked for does not do this visit: what they do, and up to three who do it. */
export function doesntDoType(clinic: ClinicConfig, vet: Provider, visitType: VisitType, lang: Language): string {
  const theirs = vet.visitTypeIds.flatMap((id) => { const v = clinic.visitTypes.find((x) => x.id === id); return v && !v.staffOnly ? [localName(v, lang).toLowerCase()] : []; });
  const others = bookableProviders(clinic.providers).filter((p) => p.id !== vet.id && p.visitTypeIds.includes(visitType.id)).slice(0, 3).map((p) => nameIn(p, lang));
  return PACKS[lang].slots.doesntDoType({ provider: nameIn(vet, lang), pronoun: pronounOf(vet), visit: localName(visitType, lang).toLowerCase(), theirVisits: theirs, others });
}

/**
 * The true reason the asked day gave nothing, or null when it did (or no day was asked for). `found` are the times
 * the search returned; `providers` who it searched.
 */
export function dayReason(clinic: ClinicConfig, q: { date: string | null; providers: Provider[]; found: Slot[]; noticeHours?: number; visit: string; now: Date; lang: Language }): { code: SlotReason; line: string } | null {
  if (!q.date) return null;
  const pack = PACKS[q.lang].slots;
  if (q.found.some((s) => localDateOf(s.start, clinic.timezone) === q.date)) return null;
  // a visit that needs notice: the first day it can be booked
  if (q.noticeHours && q.noticeHours > 2) {
    const first = localDateOf(new Date(q.now.getTime() + q.noticeHours * 3_600_000), clinic.timezone);
    if (q.date < first) return { code: 'notice', line: pack.notice({ visit: q.visit, hours: q.noticeHours, firstDate: first }) };
  }
  const open = q.providers.filter((p) => !awayOn(p, q.date!) && bookableWindows(clinic, p, q.date!).windows.length);
  const special = specialDayOf(clinic, q.date);
  const closedDay = special ? !special.windows.length : clinic.holidays.includes(q.date);
  if (closedDay && !open.length) return { code: 'clinic_closed', line: pack.clinicClosed({ date: q.date, note: special?.note ?? null }) };
  const one = q.providers.length === 1 ? q.providers[0]! : null;
  if (one && !awayOn(one, q.date) && !open.length) {
    const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => windowsOn(ownHours(clinic, one), d).length);
    return { code: 'not_working_that_day', line: pack.notWorkingThatDay({ provider: nameIn(one, q.lang), pronoun: pronounOf(one), weekday: weekdayOf(q.date), days }) };
  }
  // away that day: said by why_not_as_asked, with the day they are back
  if (one && awayOn(one, q.date)) return null;
  if (!open.length) return null;
  return { code: 'fully_booked', line: pack.fullyBooked({ provider: one ? nameIn(one, q.lang) : null, date: q.date }) };
}

/** Nothing at all in the search window: said with the last day looked at, never "in the next two weeks". */
export function nothingFound(clinic: ClinicConfig, q: { providers: Provider[]; from: string; days: number; lang: Language }): { code: SlotReason; line: string } {
  const one = q.providers.length === 1 ? q.providers[0]! : null;
  return { code: 'fully_booked', line: PACKS[q.lang].slots.nothingThrough({ provider: one ? nameIn(one, q.lang) : null, date: addDays(q.from, q.days - 1) }) };
}

/** The asked time is before the vet starts or after they finish that day: "Dr. Vance starts at 9 on Fridays." */
export function vetHoursLine(clinic: ClinicConfig, vet: Provider, date: string, time: string, lang: Language, direction: 'around' | 'before' | 'after' = 'around'): string | null {
  const windows = bookableWindows(clinic, vet, date).windows;
  if (!windows.length) return null;
  const t = toMinutes(time);
  const first = toMinutes(windows[0]!.open);
  const last = toMinutes(windows.at(-1)!.close);
  // "earlier than 6" from a vet who finishes at 6 is no time outside their hours
  if (t < first) return PACKS[lang].slots.vetHours({ provider: nameIn(vet, lang), weekday: weekdayOf(date), starts: clock(first), ends: null });
  if (t >= last && direction !== 'before') return PACKS[lang].slots.vetHours({ provider: nameIn(vet, lang), weekday: weekdayOf(date), starts: null, ends: clock(last) });
  return null;
}

/**
 * The front-desk sentence for the first offered time a vet keeps while the clinic's desk is closed, or null: "The
 * clinic's front desk is closed on Sundays, but Dr. Vance sees patients Sunday from 9 to 1."
 */
export function frontDeskLine(clinic: ClinicConfig, slots: Slot[], lang: Language): string | null {
  const slot = slots.find((s) => s.outsideClinicHours);
  const vet = slot && clinic.providers.find((p) => p.id === slot.providerId);
  if (!slot || !vet || vet.kind === 'room') return null;
  const date = localDateOf(slot.start, clinic.timezone);
  const m = localParts(slot.start, clinic.timezone).minutes;
  const { windows, clinicWindows } = bookableWindows(clinic, vet, date);
  const w = windows.find((x) => m >= toMinutes(x.open) && m < toMinutes(x.close));
  if (!w) return null;
  return PACKS[lang].slots.frontDesk({
    weekday: weekdayOf(date), provider: nameIn(vet, lang), from: clock(toMinutes(w.open)), to: clock(toMinutes(w.close)),
    clinicOpens: clinicWindows.length ? clock(toMinutes(clinicWindows[0]!.open)) : null,
    clinicCloses: clinicWindows.length ? clock(toMinutes(clinicWindows.at(-1)!.close)) : null,
    // closed that date only (a holiday, a special day), not every such weekday
    oneDay: !clinicWindows.length && windowsOn(clinic.hours, weekdayOf(date)).length ? date : null,
  });
}
