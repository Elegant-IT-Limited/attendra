// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Identity check inputs. A caller is matched on full name plus date of birth; the
 * calling number is a hint that narrows the search, never proof on its own, because
 * family members share phones and numbers are trivially spoofed.
 */

import { asciiDigits, BN_MONTHS, fold } from './locales';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_BN = BN_MONTHS.map(fold);

export function normalizeName(name: string): string {
  return name
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // José -> Jose, so transcripts without accents still match
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
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
 * Accepts "March 4th 1985", "4 March 1985", "4 de marzo de 1985", "৪ মার্চ ১৯৮৫",
 * "03/04/1985" and "1985-03-04". A numeric date is read month first in North America
 * and day first everywhere else (`order`). Two-digit years are refused: "85" is a guess.
 */
export function parseDob(input: string, today = new Date(), order: 'mdy' | 'dmy' = 'mdy'): string | null {
  const s = fold(asciiDigits(input)).toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/(\d)\s*(তারিখ|ই|এ|শে|লা|রা|ঠা)(?![\p{L}\p{M}])/gu, '$1')
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
  if (!y || !m || !d || m < 1 || m > 12) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date > today || y < today.getUTCFullYear() - 130) return null; // "Feb 30", the future, typos
  return date.toISOString().slice(0, 10);
}

function monthIndex(word: string): number {
  for (const months of [MONTHS, MONTHS_ES]) {
    const i = months.findIndex((mo) => mo === word || (word.length >= 3 && mo.startsWith(word)));
    if (i >= 0) return i;
  }
  return MONTHS_BN.indexOf(word);
}

/** Phone numbers compared on their last 10 digits, so +1 (303) 555-0100 equals 3035550100. */
export const samePhone = (a: string, b: string) => a.replace(/\D/g, '').slice(-10) === b.replace(/\D/g, '').slice(-10);
