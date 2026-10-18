// SPDX-License-Identifier: AGPL-3.0-only
import { toMinutes } from './time';
import { type ClinicConfig, genderWord, localName, type Provider, type VisitType } from './clinic';
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

/** Away the whole of a date. A part-day absence is not: see awayWindows. */
export const awayOn = (p: Pick<Provider, 'timeOff'>, date: string) => p.timeOff.some((t) => !t.start && date >= t.from && date <= t.to);
/** The parts of a date a provider is away, in clinic-local minutes. */
export const awayWindows = (p: Pick<Provider, 'timeOff'>, date: string) =>
  p.timeOff.filter((t) => t.start && t.end && t.from === date).map((t) => ({ start: toMinutes(t.start!), end: toMinutes(t.end!) }));

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
  return bookableProviders(clinic.providers).map((p) => ({
    provider_id: p.id,
    name: localName(p, language),
    kind: p.kind,
    gender: p.gender ? genderWord(p.gender) : null,
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
    ...(p.credentials?.length ? { credentials: p.credentials } : {}),
  }));
}

const IGNORED = new Set(['doctor', 'doctors', 'specialist', 'specialists', 'department', 'clinic', 'the', 'for', 'and', 'with']);
const wordsOf = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !IGNORED.has(w));
// pediatrician and pediatrics, dermatologist and dermatology, child and children
const near = (a: string, b: string) => {
  const n = Math.min(a.length, b.length, 8);
  return a === b || (n >= 5 && a.slice(0, n) === b.slice(0, n));
};

/** Animals a clinic lists under a group: a caller says "rabbit", the vet is listed for "exotics". */
const KINDS: Record<string, string[]> = {
  rabbit: ['exotic', 'exotics', 'small', 'mammal', 'mammals', 'pocket'], bunny: ['rabbit', 'exotic', 'exotics', 'small', 'mammal'],
  guinea: ['exotic', 'exotics', 'small', 'mammal', 'pocket'], hamster: ['exotic', 'exotics', 'small', 'mammal', 'pocket'], ferret: ['exotic', 'exotics', 'small', 'mammal'],
  chinchilla: ['exotic', 'exotics', 'small', 'mammal', 'pocket'], gerbil: ['exotic', 'exotics', 'small', 'mammal', 'pocket'],
  parrot: ['bird', 'birds', 'avian', 'exotic', 'exotics'], budgie: ['bird', 'birds', 'avian', 'exotic', 'exotics'], cockatiel: ['bird', 'birds', 'avian', 'exotic', 'exotics'],
  snake: ['reptile', 'reptiles', 'exotic', 'exotics'], lizard: ['reptile', 'reptiles', 'exotic', 'exotics'], gecko: ['reptile', 'reptiles', 'exotic', 'exotics'],
  turtle: ['reptile', 'reptiles', 'exotic', 'exotics'], tortoise: ['reptile', 'reptiles', 'exotic', 'exotics'], puppy: ['dog', 'dogs'], kitten: ['cat', 'cats'],
};

/** Whether a doctor is listed for what the caller asked for: their specialty or one of their categories. */
export function matchesSpecialty(p: Pick<Provider, 'specialty' | 'categories'>, asked: string): boolean {
  const want = wordsOf(asked);
  const have = wordsOf([p.specialty ?? '', ...p.categories].join(' '));
  return want.length > 0 && want.every((w) => [w, ...(KINDS[w] ?? [])].some((alt) => have.some((h) => near(alt, h))));
}

/** The providers a caller can be offered: the stand-in a new clinic starts with steps aside once anyone else is listed. */
export function bookableProviders<P extends Pick<Provider, 'placeholder'>>(providers: P[]): P[] {
  const real = providers.filter((p) => !p.placeholder);
  return real.length ? real : providers;
}

/** Each specialty and the doctors in it, as a caller may hear them. */
export function specialtyFacts(clinic: Pick<ClinicConfig, 'providers'>, language: Language) {
  const groups = new Map<string, string[]>();
  for (const p of clinic.providers) {
    if (p.kind !== 'person' || !p.specialty) continue;
    groups.set(p.specialty, [...(groups.get(p.specialty) ?? []), localName(p, language)]);
  }
  return [...groups].map(([specialty, doctors]) => ({ specialty, doctors }));
}

export function visitTypeFacts(clinic: Pick<ClinicConfig, 'visitTypes'>, language: Language) {
  return clinic.visitTypes.map((v) => ({
    visit_type_id: v.id, name: localName(v, language), minutes: v.minutes, for: audienceLine(v),
    ...(v.description ? { description: v.description } : {}),
    ...(v.staffOnly ? { booked_by: 'the team only: take a request' } : {}),
  }));
}

/** The clinic's own request topics, with what to ask the caller for each. */
export function requestTopicFacts(clinic: Pick<ClinicConfig, 'requestTopics'>) {
  return (clinic.requestTopics ?? []).map((t) => ({ topic: t.name, ...(t.collect ? { ask_for: t.collect } : {}) }));
}

/** The clinic's offers running on this clinic-local date, as a caller may hear them. */
export function currentOffers(clinic: Pick<ClinicConfig, 'offers'>, today: string) {
  return (clinic.offers ?? []).filter((o) => (!o.from || o.from <= today) && (!o.to || o.to >= today)).map((o) => ({ title: o.title, details: o.details, ...(o.to ? { until: o.to } : {}) }));
}
