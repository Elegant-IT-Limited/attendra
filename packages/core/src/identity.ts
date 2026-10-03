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

function readDob(input: string, order: 'mdy' | 'dmy'): [number, number, number] | null {
  const s = fold(input).toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
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
