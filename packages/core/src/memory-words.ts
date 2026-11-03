// SPDX-License-Identifier: AGPL-3.0-only
import { B, E, type Language, normalise, PACKS } from './locales';
import { addDays, weekdayOf } from './time';

/** A day the caller named: one date, or two when "next Wednesday" could be this week's or the week after's. */
export type SaidDay = { date: string } | { either: [string, string] };
/** A time of day the caller asked for (HH:MM): "at 5" or "around 5" is about that time, "after 3" no earlier than it. */
export interface SaidTime { time: string; mode: 'at' | 'after' }

/** What a caller's words say, by closed word lists only. A fact not said is left out; `day: null` means "any day" was said. */
export interface SaidFacts {
  species?: string;
  sex?: 'female' | 'male';
  /** As the registration reads it: "2 years", "6 months". */
  age?: string;
  intent?: 'book' | 'move' | 'cancel';
  day?: SaidDay | null;
  time?: SaidTime;
}

const lastIndex = (text: string, re: RegExp): number => {
  let at = -1;
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) at = m.index;
  return at;
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The coming day with this weekday (0 = Sunday). "this Wednesday" is the coming one, and today when today is a Wednesday;
 * a bare "Wednesday" is the coming one after today. "next Wednesday" is the coming one when that falls in next week
 * (said on a Thursday); when the coming one is still this week (said on a Monday) it could be either, and both come back.
 */
export function resolveWeekday(today: string, weekday: number, which: 'this' | 'next' | 'bare'): SaidDay {
  const todayWd = weekdayOf(today);
  const ahead = (weekday - todayWd + 7) % 7;
  if (which === 'this') return { date: addDays(today, ahead) };
  const coming = ahead === 0 ? 7 : ahead;
  const first = addDays(today, coming);
  // Monday-first weeks: the coming day is in this week when it falls before the next Monday
  const sameWeek = ((todayWd + 6) % 7) + coming <= 6;
  return which === 'next' && sameWeek ? { either: [first, addDays(first, 7)] } : { date: first };
}

/**
 * The facts in one caller turn, in the call's language: the kind of animal ("my dog", "mi perra"), its sex ("female",
 * or "she" in a turn that names the animal), its age ("two years old"), what the call is about (book, move, cancel), a
 * day ("tomorrow", "this Wednesday", "November 4") and a time ("at 5:30", "after 3"). When the same kind of fact is said
 * twice ("my dog... no, sorry, it's a cat"), the later one wins: a correction replaces. `animals` adds the clinic's own
 * kinds of animal (its vets' lists), `today` is the clinic's local date.
 */
export function extractFacts(text: string, lang: Language, opts: { today: string; animals?: string[] }): SaidFacts {
  const words = PACKS[lang].memory;
  const t = normalise(text);
  const out: SaidFacts = {};

  // the kind of animal, after a word that points at one: "my dog", "a new puppy", "es un gato"; never "she" alone
  const kinds: Record<string, string> = { ...words.species };
  for (const a of opts.animals ?? []) {
    const one = normalise(a).trim().replace(/s$/, '');
    if (one.length > 2 && !Object.values(kinds).includes(one)) kinds[one] = one;
  }
  const names = Object.keys(kinds).sort((a, b) => b.length - a.length).map(escape).join('|');
  const pointer = lang === 'es'
    ? '(?:mi|mis|nuestro|nuestra|un|una|el|la|su)\\s+(?:(?:nuevo|nueva|pequeno|pequena|viejo|vieja)\\s+)?'
    : "(?:my|our|a|an|the|his|her|their|it'?s a|new)\\s+(?:(?:new|little|old|young|big|small|baby|senior|rescue|other)\\s+)?";
  let species: string | undefined;
  for (const m of t.matchAll(new RegExp(`${B}${pointer}(${names})${E}`, 'gu'))) species = kinds[m[1]!];
  if (species) out.species = species;

  // the sex: the later of the words for each; "she" or "he" only in a turn that also names the animal
  const female = lastIndex(t, words.female);
  const male = lastIndex(t, words.male);
  if (female >= 0 || male >= 0) out.sex = female > male ? 'female' : 'male';
  else if (species) {
    const she = lastIndex(t, words.she);
    const he = lastIndex(t, words.he);
    if (she >= 0 || he >= 0) out.sex = she > he ? 'female' : 'male';
  }

  let age: string | undefined;
  for (const m of t.matchAll(words.age)) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : words.numbers[m[1]!];
    const unit = /^(year|ano)/.test(m[2]!) ? 'year' : /^(month|mes)/.test(m[2]!) ? 'month' : 'week';
    if (n) age = `${n} ${unit}${n === 1 ? '' : 's'}`;
  }
  if (age) out.age = age;

  // a change or a cancellation is what the call is about whenever it is said; between the two, the later one
  const move = lastIndex(t, words.intent.move);
  const cancel = lastIndex(t, words.intent.cancel);
  if (move >= 0 || cancel >= 0) out.intent = cancel > move ? 'cancel' : 'move';
  else if (lastIndex(t, words.intent.book) >= 0) out.intent = 'book';

  const day = saidDay(t, lang, opts.today);
  if (day !== undefined) out.day = day;
  const time = saidTime(t, lang);
  if (time) out.time = time;
  return out;
}

/** The last day named in the (normalised) text, or null for "any day", or undefined when no day was said. */
function saidDay(t: string, lang: Language, today: string): SaidDay | null | undefined {
  const w = PACKS[lang].memory;
  const found: { at: number; day: SaidDay | null }[] = [];
  const add = (re: RegExp, day: (m: RegExpMatchArray) => SaidDay | null | undefined) => {
    for (const m of t.matchAll(re)) { const d = day(m); if (d !== undefined) found.push({ at: m.index, day: d }); }
  };
  add(w.today, () => ({ date: today }));
  add(w.tomorrow, () => ({ date: addDays(today, 1) }));
  add(w.anyDay, () => null);
  const days = w.weekdays.join('|');
  add(new RegExp(`${B}(?:(${w.thisWord}|${w.nextWord}|(?:el|this coming|the)\\s+${w.nextWord}|el)\\s+)?(${days})(?:\\s+(${w.nextWord}|que viene))?${E}`, 'gu'), (m) => {
    const before = m[1] ?? '';
    const which = new RegExp(w.nextWord).test(before) || !!m[3] ? 'next' : before === w.thisWord ? 'this' : 'bare';
    return resolveWeekday(today, w.weekdays.indexOf(m[2]!), which);
  });
  const months = w.months.join('|');
  const dated = lang === 'es'
    ? new RegExp(`${B}(\\d{1,2})\\s+de\\s+(${months})${E}`, 'gu')
    : new RegExp(`${B}(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?${E}`, 'gu');
  add(dated, (m) => {
    const [dayN, monthName] = lang === 'es' ? [Number(m[1]), m[2]!] : [Number(m[2]), m[1]!];
    const month = w.months.indexOf(monthName) + 1;
    if (!month || dayN < 1 || dayN > 31) return undefined;
    const year = Number(today.slice(0, 4));
    const date = (y: number) => `${y}-${String(month).padStart(2, '0')}-${String(dayN).padStart(2, '0')}`;
    // a date already past this year is next year's
    return { date: date(year) < today ? date(year + 1) : date(year) };
  });
  if (!found.length) return undefined;
  return found.sort((a, b) => a.at - b.at).at(-1)!.day;
}

/** The last time of day named: "at 5" (17:00 in clinic hours), "5:20", "around 9 am", "after 3"; a lone number is not a time. */
function saidTime(t: string, lang: Language): SaidTime | undefined {
  const w = PACKS[lang].memory;
  let out: SaidTime | undefined;
  for (const m of t.matchAll(w.time)) {
    const [, word, h, mm, part] = m;
    if (!word && !mm && !part) continue;
    let hour = Number(h);
    const minute = mm ? Number(mm) : 0;
    if (hour > 23 || minute > 59) continue;
    if (part && w.pm.test(part) && hour < 12) hour += 12;
    else if (part && w.am.test(part) && hour === 12) hour = 0;
    // no part of the day said: a clinic's hours decide, 1 to 6 is the afternoon
    else if (!part && hour >= 1 && hour <= 6) hour += 12;
    out = { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, mode: word && w.after.test(word) ? 'after' : 'at' };
  }
  return out;
}
