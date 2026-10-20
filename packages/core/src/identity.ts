// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Identity check inputs. A caller is matched on full name plus date of birth; the
 * calling number is a hint that narrows the search, never proof on its own, because
 * family members share phones and numbers are trivially spoofed.
 */

import { fold } from './locales';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// letters with no decomposition that removing accents would reach: Ødegård, Łukasz, Æsa, Strauß
const BASE_LETTERS: Record<string, string> = { ø: 'o', ł: 'l', æ: 'ae', ß: 'ss', đ: 'd', œ: 'oe', þ: 'th', ð: 'd', ı: 'i' };

/**
 * A name as the identity check compares it: lower case, accents removed and the
 * letters above spelled with their base letters, so "Søren Ødegård" said as "Soren
 * Odegard" still matches. Letters of every script are kept; only punctuation and
 * digits become spaces.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // José -> Jose, so transcripts without accents still match
    .toLowerCase()
    .replace(/[øłæßđœþðı]/g, (c) => BASE_LETTERS[c]!)
    .replace(/[^\p{L}\p{M}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First and last name must both match; middle names and initials are ignored. */
export function namesMatch(spoken: string, onFile: string): boolean {
  const a = normalizeName(spoken).split(' ');
  const b = normalizeName(onFile).split(' ');
  return a.length >= 2 && a[0] === b[0] && a.at(-1) === b.at(-1);
}

/**
 * A spoken or typed date of birth to YYYY-MM-DD, or null when it is not certain.
 * Accepts "March 4th 1985", "4 March 1985", "4 de marzo de 1985", "03/04/1985" and
 * "1985-03-04". A numeric date is read month first in North America
 * and day first everywhere else (`order`). Two-digit years are refused: "85" is a guess.
 */
export function parseDob(input: string, today = new Date(), order: 'mdy' | 'dmy' = 'mdy'): string | null {
  const r = readDob(input, order);
  if (!r) return null;
  const [y, m, d] = r;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date > today || y < today.getUTCFullYear() - 130) return null; // "Feb 30", the future, typos
  return date.toISOString().slice(0, 10);
}

/**
 * Why a date of birth parseDob refused cannot be right, in words the assistant can
 * say back, so the caller is asked about the one part that is wrong instead of all of
 * it again. Null when the date was not understood at all.
 */
export function dobProblem(input: string, today = new Date(), order: 'mdy' | 'dmy' = 'mdy'): string | null {
  const r = readDob(input, order);
  if (!r) return null;
  const [y, m, d] = r;
  const month = MONTHS[m - 1]!.replace(/^./, (c) => c.toUpperCase());
  if (m === 2 && d === 29 && new Date(Date.UTC(y, 1, 29)).getUTCMonth() !== 1) return `February 29 is not a date in ${y}, which is not a leap year`;
  if (new Date(Date.UTC(y, m - 1, d)).getUTCMonth() !== m - 1) return `${month} has no day ${d}`;
  if (new Date(Date.UTC(y, m - 1, d)) > today) return `${month} ${d}, ${y} is in the future`;
  if (y < today.getUTCFullYear() - 130) return `${y} is too long ago`;
  return null;
}

/** "fifteenth" or "twenty-first" as a day of the month, as callers say it. */
const ORDINAL_DAYS: Record<string, number> = Object.fromEntries([
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth',
  'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth',
].map((w, i) => [w, i + 1]));
const ORDINAL_UNITS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];

/** A spoken ordinal day ("twenty-first", "the fifth") as its number, in words that are left alone otherwise. */
function ordinalDays(s: string): string {
  return s
    .replace(/\btwenty[ -](first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/g, (_, u: string) => String(21 + ORDINAL_UNITS.indexOf(u)))
    .replace(/\bthirty[ -]first\b/g, '31').replace(/\bthirtieth\b/g, '30')
    .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)\b/g, (w: string) => String(ORDINAL_DAYS[w]));
}

function readDob(input: string, order: 'mdy' | 'dmy'): [number, number, number] | null {
  const s = ordinalDays(fold(input).toLowerCase())
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    // "the 15th of January", "January the 15th"
    .replace(/\bthe /g, '').replace(/ of /g, ' ')
    .replace(/ de(l)? /g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim().replace(/^el /, '');
  let y: number | undefined, m: number | undefined, d: number | undefined;
  let r: RegExpMatchArray | null;
  const word = String.raw`([\p{L}\p{M}]+)`;
  if ((r = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) {
    [m, d, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
    if (order === 'dmy') [m, d] = [d, m];
  } else if ((r = s.match(new RegExp(`^${word} (\\d{1,2}) (\\d{4})$`, 'u')))) [m, d, y] = [monthIndex(r[1]!) + 1, Number(r[2]), Number(r[3])];
  else if ((r = s.match(new RegExp(`^(\\d{1,2}) ${word} (\\d{4})$`, 'u')))) [d, m, y] = [Number(r[1]), monthIndex(r[2]!) + 1, Number(r[3])];
  if (!y || !m || !d || m < 1 || m > 12 || d > 31) return null;
  return [y, m, d];
}

function monthIndex(word: string): number {
  for (const months of [MONTHS, MONTHS_ES]) {
    const i = months.findIndex((mo) => mo === word || (word.length >= 3 && mo.startsWith(word)));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * How many trailing digits a phone number is compared on. Nine is the national number
 * almost everywhere, whichever way it is written: +34 912 345 678 and 912 345 678,
 * +44 7911 123456 and 07911 123456, +1 (303) 555-0100 and 303-555-0100 all agree on
 * their last nine. The phone is one of three things a patient is known by, beside
 * name and date of birth, so the digit dropped from a North American area code costs
 * nothing.
 */
export const PHONE_MATCH_DIGITS = 9;
export const phoneDigits = (phone: string) => phone.replace(/\D/g, '').slice(-PHONE_MATCH_DIGITS);
export const samePhone = (a: string, b: string) => phoneDigits(a) === phoneDigits(b);

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
};

/**
 * A pet's date of birth from what an owner says: an exact date ("March 4 2021"), or an
 * age ("3 years old", "about two", "six months", "tres años"), which becomes an
 * estimated date that many years or months before today. Owners rarely know the day;
 * the vet's record only needs to be close. Null when it is neither.
 */
export function parsePetBirth(input: string, today = new Date(), order: 'mdy' | 'dmy' = 'mdy'): { dob: string; estimated: boolean } | null {
  const exact = parseDob(input, today, order);
  if (exact) return { dob: exact, estimated: false };
  const s = fold(input).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const r = s.match(/(?:^|\s)(\d{1,2}|[a-z]+)(?:\s+and\s+a\s+half)?\s*(years?|yrs?|anos?|months?|mos?|meses|mes|weeks?|semanas?)(?:\s|$)/)
    ?? (s.match(/^(?:about|around|maybe|como|unos|unas)?\s*(\d{1,2}|[a-z]+)(?:\s+(?:years? old|anos))?$/) ? [s, s.replace(/^(?:about|around|maybe|como|unos|unas)\s*/, '').split(' ')[0]!, 'years'] : null);
  if (!r) return null;
  const n = /^\d+$/.test(r[1]!) ? Number(r[1]) : NUMBER_WORDS[r[1]!];
  if (n === undefined || n < 0 || n > 40) return null;
  const unit = r[2]!;
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (/^(years?|yrs?|anos?)$/.test(unit)) d.setUTCFullYear(d.getUTCFullYear() - n);
  else if (/^(months?|mos?|meses|mes)$/.test(unit)) d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCDate(d.getUTCDate() - 7 * n);
  return { dob: d.toISOString().slice(0, 10), estimated: true };
}
