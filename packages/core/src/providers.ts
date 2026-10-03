// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, localName, type Provider, type VisitType } from './clinic';
import { windowsOn } from './hours';
import type { Language } from './locales';
import { addDays } from './time';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Whole years between a date of birth and a day, both YYYY-MM-DD. */
export function ageOn(dob: string, date: string): number {
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Whether a provider sees someone of this age. No range means everyone. */
export const seesAge = (p: Pick<Provider, 'ages'>, age: number) => !p.ages || (age >= p.ages.min && (p.ages.max === null || age <= p.ages.max));

/** Whether a provider is away on a clinic-local day. */
export const awayOn = (p: Pick<Provider, 'timeOff'>, date: string) => p.timeOff.some((t) => date >= t.from && date <= t.to);

/** "all ages", "ages 0 to 17", "ages 18 and over". */
export function agesLine(p: Pick<Provider, 'ages'>): string {
  if (!p.ages || (p.ages.min === 0 && p.ages.max === null)) return 'all ages';
  if (p.ages.max === null) return `ages ${p.ages.min} and over`;
  return `ages ${p.ages.min} to ${p.ages.max}`;
}

/** "Mon 08:00-12:00, 13:00-17:00; Tue 09:00-15:00", from the provider's own hours or the clinic's. */
export function weeklyHoursLine(hours: ClinicConfig['hours']): string {
  const days = [1, 2, 3, 4, 5, 6, 0].flatMap((d) => {
    const w = windowsOn(hours, d);
    return w.length ? [`${DAYS[d]} ${w.map((x) => `${x.open}-${x.close}`).join(', ')}`] : [];
  });
  return days.length ? days.join('; ') : 'no regular hours';
}

/** Who may book a visit type, as the assistant needs to know it. */
export const audienceLine = (v: Pick<VisitType, 'audience'>) =>
  v.audience === 'new' ? 'new patients only' : v.audience === 'existing' ? 'patients already on file only' : 'anyone';

/**
 * The clinic's providers as the assistant may describe them to any caller: no patient
 * data, nothing a caller needs to be verified for. Time off is listed for the next
 * four weeks only, which is as far as anyone asks on a call.
 */
export function providerFacts(clinic: Pick<ClinicConfig, 'providers' | 'visitTypes' | 'hours'>, today: string, language: Language) {
  const horizon = addDays(today, 28);
  return clinic.providers.map((p) => ({
    provider_id: p.id,
    name: localName(p, language),
    kind: p.kind,
    specialty: p.specialty ?? null,
    categories: p.categories,
    sees: agesLine(p),
    accepting_new_patients: p.acceptingNewPatients,
    visit_types: p.visitTypeIds.flatMap((id) => {
      const v = clinic.visitTypes.find((x) => x.id === id);
      return v ? [localName(v, language)] : [];
    }),
    hours: weeklyHoursLine(p.hours ?? clinic.hours),
    away: p.timeOff.filter((t) => t.to >= today && t.from <= horizon).map((t) => (t.from === t.to ? t.from : `${t.from} to ${t.to}`)),
  }));
}

export function visitTypeFacts(clinic: Pick<ClinicConfig, 'visitTypes'>, language: Language) {
  return clinic.visitTypes.map((v) => ({ visit_type_id: v.id, name: localName(v, language), minutes: v.minutes, for: audienceLine(v) }));
}
