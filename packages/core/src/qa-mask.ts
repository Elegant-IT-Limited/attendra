// SPDX-License-Identifier: AGPL-3.0-only
import { maskDigitRuns } from './handoffs';

/**
 * The QA export's transcript (foundation A, item 1): the words as said, with the numbers that identify someone masked
 * before anything leaves the database's process. Masked: any run of 4 digits or more, written ("555-0147", "2019") or
 * said ("five five five oh one four seven"), as [number]; written dates ("03/04/2019") as [date]; emails as [email];
 * and on a line about a birthday or a date of birth (or the line right after one: "When was Biscuit born?" "March 3rd")
 * every date as [date]. Names, times ("2:30") and short numbers ("two dogs", "room 3") stay: the review is about how
 * the assistant spoke, and the export is read under a key the clinic made for it.
 */
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const ORDINALS = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty[- ](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|thirtieth|thirty[- ]first|primero';
const DAY = `(?:\\d{1,2}(?:st|nd|rd|th)?|${ORDINALS})`;
const YEAR = '(?:,?[ \\t]?\\d{2,4})?';
/** A day and a month in words, either way round, with a year if one follows: "March 3rd, 2019", "the 5th of May", "3 de mayo". */
const WORD_DATE = new RegExp(`\\b(?:(?:the[ \\t])?${DAY}[ \\t](?:of[ \\t]|de[ \\t])?(?:${MONTHS})\\b${YEAR}|(?:${MONTHS})\\.?[ \\t](?:the[ \\t])?${DAY}\\b${YEAR})`, 'gi');
/** A date written with / . or - between day, month and year: "03/04/2019", "2019-03-04", "3.4.19". */
const WRITTEN_DATE = /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}\b/g;
/** A day and month alone with a slash ("3/4"): a date only on a birthday line. */
const SHORT_DATE = /\b\d{1,2}\/\d{1,2}\b/g;
/** A line about when someone (or a pet) was born. */
const BIRTH = /\b(?:birth|births|birthday|birthdate|born|dob|d\.o\.b|nacimiento|naci[oó]|cumplea[nñ]os)\b/i;

/** One line, masked. `birthday`: the line is about a date of birth (it or the line before mentions one). */
export function maskQaLine(line: string, birthday = BIRTH.test(line)): string {
  let t = line.replace(WRITTEN_DATE, '[date]');
  if (birthday) t = t.replace(WORD_DATE, '[date]').replace(SHORT_DATE, '[date]');
  return maskDigitRuns(t, 4, () => '[number]');
}

/** A call's lines, masked; a line after one that mentions a birth or birthday is read as an answer about it. */
export function maskQaTranscript<T extends { text: string }>(lines: readonly T[]): T[] {
  return lines.map((l, i) => ({ ...l, text: maskQaLine(l.text, BIRTH.test(l.text) || (i > 0 && BIRTH.test(lines[i - 1]!.text))) }));
}
