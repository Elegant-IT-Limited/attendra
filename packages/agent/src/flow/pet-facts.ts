// SPDX-License-Identifier: AGPL-3.0-only
import { isClearYes, LANGUAGES, normalise, PACKS } from '@attendra/core';
import type { CallState } from '../call-state';

/**
 * A new pet's kind, sex and age are written to its record only as the caller said them (T1, a tester's call
 * 2026-11-24): "Can you hear me?" was registered as "a cat", "Perdón" as "a dog", and "Sí, eso" as an age nobody gave.
 * The model's argument is checked against the caller's own words since the last pet was found or added, or a clear yes
 * to the assistant's question that named the value ("Is Bolt about four months old?" "Yes."). Closed word lists, in
 * every language the product speaks; a value the words do not carry is asked for again, never guessed.
 */
export type PetFact = 'species' | 'sex' | 'age';

/** A sentence as the checks read it: normalised, with spaces around it, digits and decimals kept ("1.5"). */
const flat = (text: string) => ` ${normalise(text).replace(/(\d)[.,](\d)/g, '$1_$2').replace(/[^\p{L}\p{N}'_ ]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
const sentences = (text: string) => text.split(/(?<=[.!?¿¡])\s+|(?<=[.!?])(?=\S)/).map((s) => s.trim()).filter(Boolean);

/**
 * The caller's words since the last pet was found or added, sentence by sentence, and each QUESTION a clear yes
 * answered ("Is Tango a cat?" "Yes."): never a statement the caller only acknowledged ("Got it, Tango is a cat."
 * "Okay."), and never a choice ("a boy or a girl?"), which a yes answers neither way (reviewer, T1).
 */
function evidenceRaw(state: CallState): string[] {
  const turns = state.turns.slice(state.newFromTurn);
  const out: string[] = [];
  turns.forEach((t, i) => {
    if (t.speaker !== 'caller') return;
    out.push(...sentences(t.text));
    const asked = turns.slice(0, i).reverse().find((x) => x.speaker === 'agent');
    if (!asked || !isClearYes(t.text, LANGUAGES)) return;
    const question = sentences(asked.text).filter((s) => /\?\s*$/.test(s)).at(-1);
    if (question && !/\b(?:or|o)\b/i.test(normalise(question))) out.push(question);
  });
  return out;
}
const evidence = (state: CallState) => evidenceRaw(state).map(flat);

/** A date's parts as said: year, month and day where each was said ("March 3rd 2023", "3 de marzo", "3/3/2023", "2023"). */
interface DateParts { y?: number; m?: number; d?: number }
const MONTH_NAMES = '(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)';
function datesIn(text: string): DateParts[] {
  const t = normalise(text).replace(/\b(\d{1,2})(?:st|nd|rd|th|ro|do|to)\b/g, '$1');
  const month = (w: string) => MONTH_NUMBER[w];
  const out: DateParts[] = [];
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_NAMES}\\s+(\\d{1,2})(?!\\d)(?:,?\\s+(?:of\\s+|de\\s+)?(\\d{4}))?`, 'g'))) out.push({ m: month(m[1]!), d: Number(m[2]), ...(m[3] ? { y: Number(m[3]) } : {}) });
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+|of\\s+)?${MONTH_NAMES}(?:,?\\s+(?:de\\s+|del\\s+)?(\\d{4}))?`, 'g'))) out.push({ d: Number(m[1]), m: month(m[2]!), ...(m[3] ? { y: Number(m[3]) } : {}) });
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_NAMES}\\s+(?:of\\s+|de\\s+|del\\s+)?(\\d{4})`, 'g'))) out.push({ m: month(m[1]!), y: Number(m[2]) });
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) out.push({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) });
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g)) {
    const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    out.push({ m: Number(m[1]), d: Number(m[2]), y }, { m: Number(m[2]), d: Number(m[1]), y }); // either order: the arg decides
  }
  for (const m of t.matchAll(/\b((?:19|20)\d{2})\b/g)) out.push({ y: Number(m[1]) });
  return out;
}

/**
 * Whether the caller said this date: its year somewhere, and its month and day said together as a month and a day (a
 * month or day never said is asked for, never filled; reviewer, T1: "May 3rd 2023" was taken for 2023-03-03).
 */
function saidDate(said: string[], want: DateParts): boolean {
  const found = said.flatMap(datesIn);
  const yearOk = want.y === undefined || found.some((p) => p.y === want.y);
  const monthDayOk = want.m === undefined || found.some((p) => p.m === want.m && (want.d === undefined || p.d === want.d));
  return yearOk && monthDayOk;
}

const has = (text: string, word: string) => text.includes(` ${word} `);
const plural = (w: string) => [w, `${w}s`, `${w}es`];

/** Every word for a kind of animal, in every language, to the English name kept on the record. */
const KINDS: Record<string, string> = Object.assign({}, ...LANGUAGES.map((l) => PACKS[l].memory.species));
const kindOf = (word: string) => { const w = normalise(word).trim(); return KINDS[w] ?? KINDS[w.replace(/e?s$/, '')] ?? w; };

function saidSpecies(said: string[], species: string): boolean {
  const text = said.join(' ');
  const want = kindOf(species);
  if (Object.entries(KINDS).some(([word, kind]) => kind === want && plural(normalise(word)).some((w) => has(text, w)))) return true;
  // a kind of animal no list has (an iguana, a goat): the caller's own word for it
  return normalise(species).split(/\s+/).filter((w) => w.length > 2).every((w) => plural(w).some((x) => has(text, x)));
}

// in Spanish a pet's sex is also in the word said of it: "es nueva", "está chiquita" (a female), "es nuevo" (a male)
const FEMALE = /\b(?:female|girl|she|her|hers|she's|spayed|hembra|nina|ella|perra|perrita|gata|gatita|coneja|cachorra|esterilizada|(?:es|esta) (?:nueva|chiquita|pequena|viejita|una nina))\b/;
const MALE = /\b(?:male|boy|he|him|his|he's|neutered|macho|nino|castrado|perrito|gatito|(?:es|esta) (?:nuevo|chiquito|pequeno|viejito|un nino))\b/;
/** Words for the sex that say it whoever they are about ("a girl", "macho"); "she" and "he" only about the pet. */
const FEMALE_WORD = /\b(?:female|girl|spayed|hembra|nina|perra|perrita|gata|gatita|coneja|cachorra|esterilizada|(?:es|esta) (?:nueva|chiquita|pequena|viejita|una nina))\b/;
const MALE_WORD = /\b(?:male|boy|neutered|macho|nino|castrado|perrito|gatito|(?:es|esta) (?:nuevo|chiquito|pequeno|viejito|un nino))\b/;
function saidSex(said: string[], sex: string, pet: string | null): boolean {
  if (sex !== 'female' && sex !== 'male') return true; // "unknown" invents nothing: the record says the owner did not say
  const [word, pronoun] = sex === 'female' ? [FEMALE_WORD, FEMALE] : [MALE_WORD, MALE];
  // a pronoun counts in a short answer, or in a sentence that is about the pet (its name or its kind of animal), or in
  // the sentence after one that named it ("I have a new dog, Rex. She's two."); "the vet said she..." is someone else
  const aboutPet = (s: string) => (pet ? s.includes(` ${normalise(pet)} `) : false) || Object.keys(KINDS).some((k) => s.includes(` ${normalise(k)} `));
  return said.some((s, i) => word.test(s) || (pronoun.test(s) && (s.trim().split(' ').length <= 4 || aboutPet(s) || (i > 0 && aboutPet(said[i - 1]!) && !/\b(?:said|told|says|dijo|dice)\b/.test(s)))));
}

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, half: 0.5,
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, medio: 0.5,
};
/** "a", "an", "un", "una" are one only next to a unit: "a year", "un año". */
const ONE_BEFORE_UNIT = /\b(?:a|an|un|una|uno)\s+(?:year|month|week|ano|mes|semana)/;
const FILLER = new Set(['about', 'around', 'roughly', 'maybe', 'years', 'year', 'old', 'months', 'month', 'weeks', 'week', 'como', 'unos', 'unas', 'anos', 'ano', 'meses', 'mes', 'semanas', 'semana', 'more', 'less', 'mas', 'menos', 'the', 'and', 'born', 'birthday']);

const MONTH_NUMBER: Record<string, number> = Object.fromEntries([
  ...['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].map((m, i) => [m, i + 1]),
  ...['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'].map((m, i) => [m, i + 1]),
  ['setiembre', 9],
]);
/**
 * The numbers a phrase says: digits, decimals ("1.5"), ordinals ("3rd"), number words, a month by its number (so "March
 * 3rd 2023" and "2023-03-03" say the same), "a year and a half" and "año y medio" as 1.5 (one before a unit only).
 */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  const t = text.replace(/\b(\d+)(?:st|nd|rd|th|ro|do|to|vo|no|mo)\b/g, '$1');
  for (const m of t.matchAll(/\b\d+(?:_\d+)?\b|\b\p{L}+\b/gu)) {
    const w = m[0];
    if (/^\d+(?:_\d+)?$/.test(w)) out.push(Number(w.replace('_', '.')));
    else if (NUMBERS[w] !== undefined) out.push(NUMBERS[w]);
    else if (MONTH_NUMBER[w] !== undefined) out.push(MONTH_NUMBER[w]);
  }
  if (ONE_BEFORE_UNIT.test(t)) out.push(1);
  // "N and a half", "N y medio", "a year and a half", "año y medio": N + 0.5
  for (const m of t.matchAll(new RegExp(`\\b(\\d+|a|an|un|una|uno|${Object.keys(NUMBERS).join('|')})?\\s*(?:years?|months?|anos?|meses|mes)?\\s*(?:and a half|y medio)\\b`, 'gu'))) {
    const n = m[1] ? (/^\d+$/.test(m[1]) ? Number(m[1]) : NUMBERS[m[1]] ?? (/^(?:a|an|un|una|uno|ano)$/.test(m[1]) ? 1 : undefined)) : 1;
    if (n !== undefined) out.push(n + 0.5);
  }
  return out;
}

function saidAge(sentencesSaid: string[], age: string, raw: string[] = []): boolean {
  // a date is its parts, said as such; an age is its numbers
  const asDate = datesIn(age).find((p) => p.m !== undefined) ?? (/^\s*(?:19|20)\d{2}\s*$/.test(age) ? { y: Number(age.trim()) } : undefined);
  if (asDate) return saidDate(raw, asDate);
  const text = sentencesSaid.join(' ');
  const a = flat(age);
  const said = new Set(numbersIn(text));
  // "a year and a half" is 1.5, not also a lone "half" or "one"
  const wanted = /(?:and a half|y medio)/.test(a) ? numbersIn(a).filter((n) => n % 1 !== 0) : numbersIn(a).filter((n, _i, all) => !(n === 0.5 && all.some((x) => x % 1 !== 0 && x !== 0.5)));
  if (wanted.length) return wanted.every((n) => said.has(n));
  // no number at all ("a puppy", "young"): the caller's own words for it
  const words = a.trim().split(' ').filter((w) => w.length > 2 && !FILLER.has(w));
  return words.length > 0 && words.every((w) => has(text, w));
}

/** The first of the pet's details the model passed that the caller did not say, or null when every one was said. */
export function petFactNotSaid(state: CallState, args: { species?: unknown; sex?: unknown; birthday_or_age?: unknown; pet_name?: unknown }): PetFact | null {
  const said = evidence(state);
  const pet = typeof args.pet_name === 'string' && args.pet_name.trim() ? args.pet_name.trim() : state.memory.get('petName') ?? null;
  if (typeof args.species === 'string' && args.species.trim() && !saidSpecies(said, args.species)) return 'species';
  if (typeof args.sex === 'string' && args.sex && !saidSex(said, args.sex, pet)) return 'sex';
  if (typeof args.birthday_or_age === 'string' && args.birthday_or_age.trim() && !saidAge(said, args.birthday_or_age, evidenceRaw(state))) return 'age';
  return null;
}
