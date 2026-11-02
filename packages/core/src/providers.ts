// SPDX-License-Identifier: AGPL-3.0-only
import { toMinutes } from './time';
import { type ClinicConfig, genderWord, localName, type Provider, type VisitType } from './clinic';
import { sharedCustomFacts } from './custom-fields';
import { windowsOn } from './hours';
import { phoneDigits } from './identity';
import { asE164 } from './phones';
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
 * four weeks only, which is as far as anyone asks on a call. The clinic's own fields
 * on each one come under their labels, except those it keeps for the team.
 */
export function providerFacts(clinic: Pick<ClinicConfig, 'providers' | 'visitTypes' | 'hours' | 'providerFields'>, today: string, language: Language) {
  const horizon = addDays(today, 28);
  return bookableProviders(clinic.providers).map((p) => ({
    provider_id: p.id,
    name: providerName(p, language),
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
    // a part of a day says which part: "2026-10-22 13:00 to 18:00", never the whole day
    away: p.timeOff.filter((t) => t.to >= today && t.from <= horizon).map((t) => (t.start && t.end ? `${t.from} ${t.start} to ${t.end}` : t.from === t.to ? t.from : `${t.from} to ${t.to}`)),
    ...(p.credentials?.length ? { credentials: p.credentials } : {}),
    ...withDetails(sharedCustomFacts(clinic.providerFields, p.custom)),
  }));
}

const withDetails = (details: Record<string, string>) => (Object.keys(details).length ? { details } : {});

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
  turtle: ['reptile', 'reptiles', 'exotic', 'exotics'], tortoise: ['reptile', 'reptiles', 'exotic', 'exotics'], puppy: ['dog', 'dogs', 'canine'], kitten: ['cat', 'cats', 'feline'],
  dog: ['canine'], cat: ['feline'], horse: ['equine', 'pony'], pony: ['horse', 'equine'], bird: ['avian'],
  // the same in Spanish, as a Spanish-speaking owner names the animal: "perro", "gata", "conejo"
  perro: ['dog', 'dogs', 'canine'], perra: ['dog', 'dogs', 'canine'], cachorro: ['dog', 'dogs', 'canine'], gato: ['cat', 'cats', 'feline'], gata: ['cat', 'cats', 'feline'],
  gatito: ['cat', 'cats', 'feline'], conejo: ['rabbit', 'exotic', 'exotics', 'small', 'mammal'], huron: ['ferret', 'exotic', 'exotics', 'small', 'mammal'],
  cobayo: ['guinea', 'exotic', 'exotics', 'small', 'mammal', 'pocket'], cuyo: ['guinea', 'exotic', 'exotics', 'small', 'mammal', 'pocket'],
  loro: ['parrot', 'bird', 'birds', 'avian', 'exotic', 'exotics'], perico: ['parrot', 'bird', 'birds', 'avian', 'exotic', 'exotics'], pajaro: ['bird', 'birds', 'avian', 'exotic', 'exotics'],
  ave: ['bird', 'birds', 'avian', 'exotic', 'exotics'], serpiente: ['snake', 'reptile', 'reptiles', 'exotic', 'exotics'], lagarto: ['lizard', 'reptile', 'reptiles', 'exotic', 'exotics'],
  tortuga: ['turtle', 'reptile', 'reptiles', 'exotic', 'exotics'], caballo: ['horse', 'equine', 'pony'],
};

/** Words that name animals (not services), for telling "Rabbits" or "Exotics" from "Dentistry". */
const ANIMALS = new Set([
  ...Object.keys(KINDS), ...Object.values(KINDS).flat().filter((w) => w !== 'small' && w !== 'pocket'),
  'dog', 'dogs', 'cat', 'cats', 'canine', 'feline', 'horse', 'horses', 'equine', 'pony', 'bird', 'birds', 'avian', 'reptile', 'reptiles',
  'exotic', 'exotics', 'rabbits', 'ferrets', 'rodent', 'rodents', 'livestock', 'cattle', 'goat', 'goats', 'sheep', 'pig', 'pigs', 'poultry', 'fish', 'amphibian', 'amphibians', 'wildlife',
]);

/** Whether a vet lists any kind of animal among what they see; one who lists none sees every animal. */
export const listsAnimals = (p: Pick<Provider, 'categories'>) => p.categories.some((c) => wordsOf(c).some((w) => ANIMALS.has(w)));

/** Whether a vet sees this kind of animal: listed for it (a rabbit under "Exotics" too), or lists no animals at all. */
export function seesAnimal(p: Pick<Provider, 'categories'>, species: string): boolean {
  if (!listsAnimals(p)) return true;
  // "dog" and "Dogs", "rabbit" and "Exotics"
  const one = (w: string) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
  const want = wordsOf(species).flatMap((w) => [w, ...(KINDS[one(w)] ?? KINDS[w] ?? [])]).map(one);
  const have = p.categories.flatMap(wordsOf).map(one);
  return want.length > 0 && want.some((w) => have.some((h) => near(w, h)));
}

/**
 * The provider a patient usually sees: the one with the most past visits in the last
 * two years (cancelled ones do not count), the most recent breaking a tie. Null with none.
 */
export function usualProviderOf(visits: { providerId: string; start: Date; status?: string }[], now: Date): string | null {
  const since = now.getTime() - 730 * 86_400_000;
  const seen = new Map<string, { n: number; last: number }>();
  for (const v of visits) {
    const t = v.start.getTime();
    if ((v.status && v.status !== 'booked') || t >= now.getTime() || t < since) continue;
    const s = seen.get(v.providerId) ?? { n: 0, last: 0 };
    seen.set(v.providerId, { n: s.n + 1, last: Math.max(s.last, t) });
  }
  return [...seen.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)[0]?.[0] ?? null;
}

/** Whether a doctor is listed for what the caller asked for: their specialty or one of their categories. */
export function matchesSpecialty(p: Pick<Provider, 'specialty' | 'categories'>, asked: string): boolean {
  // "cat" and "Cats", "dentist" and "Dentistry": a plural or a stem is the same thing
  const one = (w: string) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
  const want = wordsOf(asked).map(one);
  const have = wordsOf([p.specialty ?? '', ...p.categories].join(' ')).map(one);
  return want.length > 0 && want.every((w) => [w, ...(KINDS[w] ?? [])].map(one).some((alt) => have.some((h) => near(alt, h))));
}

/** Every number a provider has: their own first, then the others. */
export const providerPhones = (p: Pick<Provider, 'phone' | 'otherPhones'>): string[] => [p.phone, ...(p.otherPhones ?? [])].filter((x): x is string => !!x);

/** A person at a vet clinic with no number yet: the page asks for one until it is there. The stand-in never needs one. */
export const needsPhone = (clinic: Pick<ClinicConfig, 'industry'>, p: Pick<Provider, 'kind' | 'phone' | 'placeholder'>) =>
  clinic.industry === 'vet' && p.kind === 'person' && !p.placeholder && !p.phone;

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * A provider's numbers, checked: each written as the clinic's country dials it (kept in E.164), none the same twice,
 * none already another provider's at this clinic (compared as E.164, however each was written), and at a vet
 * clinic a new person needs one, because the number is what tells one vet from another (2026-11-01). The same number at
 * another clinic is fine. Problems come back under their field, for the form and the import alike.
 */
export function providerPhoneIssues(clinic: Pick<ClinicConfig, 'industry' | 'phoneNumbers' | 'providers'>,
  candidate: { kind?: string; placeholder?: boolean; phone?: string | null; otherPhones?: string[] | null }, currentId?: string,
): { phone?: string; otherPhones?: string[]; issues: { path: 'phone' | 'otherPhones'; message: string }[] } {
  const issues: { path: 'phone' | 'otherPhones'; message: string }[] = [];
  const typed = candidate.phone?.trim() ?? '';
  const phone = typed ? asE164(clinic, typed) : undefined;
  if (phone && !E164.test(phone)) issues.push({ path: 'phone', message: 'Check the phone number: write it as you would dial it, or with its country code.' });
  const others = (candidate.otherPhones ?? []).map((x) => x.trim()).filter(Boolean).map((x) => asE164(clinic, x));
  if (others.some((x) => !E164.test(x))) issues.push({ path: 'otherPhones', message: 'Check the other numbers: write each as you would dial it, or with its country code.' });
  if (!currentId && !phone && needsPhone(clinic, { kind: (candidate.kind ?? 'person') as Provider['kind'], placeholder: candidate.placeholder, phone: undefined })) {
    issues.push({ path: 'phone', message: 'A phone number is needed: it is what tells one veterinarian from another.' });
  }
  const one = (x: string) => asE164(clinic, x);
  const mine = [phone, ...others].filter((x): x is string => !!x).map(one);
  if (new Set(mine).size !== mine.length) issues.push({ path: 'otherPhones', message: 'The same number is listed twice.' });
  for (const other of clinic.providers) {
    if (other.id === currentId) continue;
    const theirs = providerPhones(other).map(one);
    const clash = mine.find((d) => theirs.includes(d));
    if (clash === undefined) continue;
    issues.push({ path: phone && phone === clash ? 'phone' : 'otherPhones', message: `${providerName(other)} already has this number.` });
    break;
  }
  return { phone, otherPhones: others.length ? others : undefined, issues };
}

/** The providers at a clinic that share a number, counted: how many numbers are on more than one, and how many providers that is. */
export function sharedProviderPhones(providers: Pick<Provider, 'id' | 'phone' | 'otherPhones'>[], clinic?: { phoneNumbers: readonly string[] }): { numbers: number; providers: number } {
  const byDigits = new Map<string, Set<string>>();
  for (const p of providers) for (const d of new Set(providerPhones(p).map((x) => (clinic ? asE164(clinic, x) : phoneDigits(x))))) byDigits.set(d, new Set([...(byDigits.get(d) ?? []), p.id]));
  const shared = [...byDigits.values()].filter((ids) => ids.size > 1);
  return { numbers: shared.length, providers: new Set(shared.flatMap((ids) => [...ids])).size };
}

/** The providers a caller can be offered: the stand-in a new clinic starts with steps aside once anyone else is listed. */
export function bookableProviders<P extends Pick<Provider, 'placeholder'>>(providers: P[]): P[] {
  const real = providers.filter((p) => !p.placeholder);
  return real.length ? real : providers;
}

/**
 * The providers the dashboard lists (Doctors, Today, the Schedule, a new booking): the same as a
 * caller is offered, so the stand-in is gone once anyone else is listed. A stand-in that still has
 * visits on screen (`withVisits`, provider ids) stays, so no visit disappears from the calendar.
 */
export function shownProviders<P extends Pick<Provider, 'id' | 'placeholder'>>(providers: P[], withVisits: Iterable<string> = []): P[] {
  const bookable = new Set(bookableProviders(providers).map((p) => p.id));
  for (const id of withVisits) bookable.add(id);
  return providers.filter((p) => bookable.has(p.id));
}

/** Each specialty and the doctors in it, as a caller may hear them. */
export function specialtyFacts(clinic: Pick<ClinicConfig, 'providers'>, language: Language) {
  const groups = new Map<string, string[]>();
  for (const p of clinic.providers) {
    if (p.kind !== 'person' || !p.specialty) continue;
    groups.set(p.specialty, [...(groups.get(p.specialty) ?? []), providerName(p, language)]);
  }
  return [...groups].map(([specialty, doctors]) => ({ specialty, doctors }));
}

export function visitTypeFacts(clinic: Pick<ClinicConfig, 'visitTypes'>, language: Language) {
  return clinic.visitTypes.map((v) => ({
    visit_type_id: v.id, name: localName(v, language), minutes: v.minutes, for: audienceLine(v),
    ...(v.description ? { description: v.description } : {}),
    ...(v.staffOnly ? { booked_by: 'the team only: take a request' } : {}),
    // the limits, team-booked visits included, said only when they decide something ("at least 25 hours ahead")
    ...(v.noticeHours ? { notice: `at least ${noticeWords(v.noticeHours)} ahead` } : {}),
    ...(v.maxDaysAhead ? { furthest: `at most ${v.maxDaysAhead} day${v.maxDaysAhead === 1 ? '' : 's'} ahead` } : {}),
  }));
}

/** A notice as people say it: whole days as days ("3 days"), anything else in hours ("25 hours"). */
export const noticeWords = (hours: number) => (hours >= 24 && hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`);

/**
 * The bookable visit a caller can have instead of one the team books: one whose name shares a word with it
 * ("surgery consultation" for "surgery"), or null. Never another team-booked one.
 */
export function relatedBookable(clinic: Pick<ClinicConfig, 'visitTypes'>, staffBooked: { id: string; name: string }): { id: string; name: string } | null {
  const wordsOf = (name: string) => name.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 4);
  // the same word, or the same stem ("surgical" and "surgery"): at least four letters in common from the start
  const stem = (a: string, b: string) => { let n = 0; while (n < a.length && a[n] === b[n]) n++; return n >= 4; };
  const words = wordsOf(staffBooked.name);
  return clinic.visitTypes.find((v) => v.id !== staffBooked.id && !v.staffOnly && wordsOf(v.name).some((x) => words.some((w) => stem(w, x)))) ?? null;
}

/** The clinic's own request topics, with what to ask the caller for each. */
export function requestTopicFacts(clinic: Pick<ClinicConfig, 'requestTopics'>) {
  return (clinic.requestTopics ?? []).map((t) => ({ topic: t.name, ...(t.collect ? { ask_for: t.collect } : {}) }));
}

/** The clinic's offers running on this clinic-local date, as a caller may hear them. */
export function currentOffers(clinic: Pick<ClinicConfig, 'offers'>, today: string) {
  return (clinic.offers ?? []).filter((o) => (!o.from || o.from <= today) && (!o.to || o.to >= today)).map((o) => ({ title: o.title, details: o.details, ...(o.to ? { until: o.to } : {}) }));
}

/** A title someone typed before a name: "Dr", "Dr.", "Dra.", "Doctor", "Mr", "Mrs", "Ms", "Miss". Names are stored without one. */
const TYPED_TITLE = /^\s*(?:dr|dra|doctor|doctora|mr|mrs|ms|miss)\.?(?:\s+|$)/i;

/** A name as it is stored: trimmed, with any title typed before it taken off ("Dr. Elena Ruiz" is "Elena Ruiz"). */
export const bareName = (name: string) => name.replace(TYPED_TITLE, '').trim() || name.trim();

/** Whether a typed name started with a title, so the field can say "We add Dr. for you". */
export const hadTitle = (name: string) => TYPED_TITLE.test(name) && bareName(name) !== name.trim();

/** The title a provider is said with: their own choice, or "dr" for a person and none for a room. */
export const titleOf = (p: { kind?: 'person' | 'room'; title?: 'dr' | 'none' | undefined }) => (p.kind === 'room' ? 'none' : p.title ?? 'dr');

/**
 * A provider's name the one way it is said and shown everywhere: "Dr. Elena Ruiz", in Spanish "Dra. Elena Ruiz" for a
 * woman ("Dr." when the gender isn't known), the name alone for a groomer or a room. A title already typed into the name
 * is never said twice.
 */
export function providerName(p: { name: string; names?: Partial<Record<Language, string>> | undefined; kind?: 'person' | 'room'; title?: 'dr' | 'none' | undefined; gender?: string | undefined; placeholder?: boolean | undefined }, language: Language = 'en'): string {
  const name = bareName(localName(p, language));
  // the stand-in a new clinic starts with is "our veterinarian", never "Dr. our veterinarian"
  if (titleOf(p) === 'none' || p.placeholder) return name;
  return `${language === 'es' && p.gender === 'female' ? 'Dra.' : 'Dr.'} ${name}`;
}
