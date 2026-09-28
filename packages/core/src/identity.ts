// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Identity check inputs. A caller is matched on full name plus date of birth; the
 * calling number is a hint that narrows the search, never proof on its own, because
 * family members share phones and numbers are trivially spoofed.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

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
 * Accepts "March 4th 1985", "4 March 1985", "03/04/1985" (US order: month first) and
 * "1985-03-04". Two-digit years are refused: "85" is a guess.
 */
export function parseDob(input: string, today = new Date()): string | null {
  const s = input.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  let y: number | undefined, m: number | undefined, d: number | undefined;
  let r: RegExpMatchArray | null;
  if ((r = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [m, d, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^([a-z]+) (\d{1,2}) (\d{4})$/))) [m, d, y] = [monthIndex(r[1]!) + 1, Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^(\d{1,2}) ([a-z]+) (\d{4})$/))) [d, m, y] = [Number(r[1]), monthIndex(r[2]!) + 1, Number(r[3])];
  if (!y || !m || !d || m < 1 || m > 12) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date > today || y < today.getUTCFullYear() - 130) return null; // "Feb 30", the future, typos
  return date.toISOString().slice(0, 10);
}

function monthIndex(word: string): number {
  return MONTHS.findIndex((mo) => mo === word || (word.length >= 3 && mo.startsWith(word)));
}

/** Phone numbers compared on their last 10 digits, so +1 (303) 555-0100 equals 3035550100. */
export const samePhone = (a: string, b: string) => a.replace(/\D/g, '').slice(-10) === b.replace(/\D/g, '').slice(-10);
