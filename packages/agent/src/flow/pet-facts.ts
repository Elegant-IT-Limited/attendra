// SPDX-License-Identifier: AGPL-3.0-only
import { isClearYes, type Language, languageAfterTurn, LANGUAGES, normalise, PACKS } from '@attendra/core';
import type { CallState } from '../call-state';

/**
 * A new pet's kind, sex and age are written to its record only as the caller said them (T1, a tester's call
 * 2026-11-24): "Can you hear me?" was registered as "a cat", "Perdón" as "a dog", and "Sí, eso" as an age nobody gave.
 * The model's argument is checked against the caller's own words since the last pet was found or added, or a clear yes
 * to the assistant's question that named the value ("Is Bolt about four months old?" "Yes."). Closed word lists, in
 * every language the product speaks; a value the words do not carry is asked for again, never guessed.
 */
export type PetFact = 'species' | 'sex' | 'age';

/** The caller's words since the last pet was found or added, with each question a clear yes answered. */
function evidence(state: CallState): string {
  const turns = state.turns.slice(state.newFromTurn);
  const parts: string[] = [];
  turns.forEach((t, i) => {
    if (t.speaker !== 'caller') return;
    parts.push(t.text);
    const asked = turns.slice(0, i).reverse().find((x) => x.speaker === 'agent');
    // a yes to "a boy or a girl?" answers neither
    if (asked && isClearYes(t.text, LANGUAGES) && !/\b(?:or|o)\b/i.test(normalise(asked.text))) parts.push(asked.text);
  });
  return ` ${normalise(parts.join(' . ')).replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ')} `;
}

const has = (text: string, word: string) => text.includes(` ${word} `);
const plural = (w: string) => [w, `${w}s`, `${w}es`];

/** Every word for a kind of animal, in every language, to the English name kept on the record. */
const KINDS: Record<string, string> = Object.assign({}, ...LANGUAGES.map((l) => PACKS[l].memory.species));
const kindOf = (word: string) => { const w = normalise(word).trim(); return KINDS[w] ?? KINDS[w.replace(/e?s$/, '')] ?? w; };

function saidSpecies(text: string, species: string): boolean {
  const want = kindOf(species);
  if (Object.entries(KINDS).some(([word, kind]) => kind === want && plural(normalise(word)).some((w) => has(text, w)))) return true;
  // a kind of animal no list has (an iguana, a goat): the caller's own word for it
  return normalise(species).split(/\s+/).filter((w) => w.length > 2).every((w) => plural(w).some((x) => has(text, x)));
}

// in Spanish a pet's sex is also in the word said of it: "es nueva", "está chiquita" (a female), "es nuevo" (a male)
const FEMALE = /\b(?:female|girl|she|her|hers|she's|spayed|hembra|nina|ella|perra|perrita|gata|gatita|coneja|cachorra|esterilizada|(?:es|esta) (?:nueva|chiquita|pequena|viejita|una nina))\b/;
const MALE = /\b(?:male|boy|he|him|his|he's|neutered|macho|nino|castrado|perrito|gatito|(?:es|esta) (?:nuevo|chiquito|pequeno|viejito|un nino))\b/;
function saidSex(text: string, sex: string): boolean {
  if (sex === 'female') return FEMALE.test(text);
  if (sex === 'male') return MALE.test(text);
  // "unknown" invents nothing: the record says the owner did not say
  return true;
}

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, half: 0.5,
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, medio: 0.5,
};
/** "a", "an", "un", "una" are one only next to a unit: "a year", "un año". */
const ONE_BEFORE_UNIT = /\b(?:a|an|un|una|uno)\s+(?:year|month|week|ano|mes|semana)/;
const MONTHS = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/g;
const FILLER = new Set(['about', 'around', 'roughly', 'maybe', 'years', 'year', 'old', 'months', 'month', 'weeks', 'week', 'como', 'unos', 'unas', 'anos', 'ano', 'meses', 'mes', 'semanas', 'semana', 'more', 'less', 'mas', 'menos', 'the', 'and', 'born', 'birthday']);

/** The numbers a phrase says, as digits or words (one before a unit only). */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\b\d{1,4}\b|\b\p{L}+\b/gu)) {
    const w = m[0];
    if (/^\d+$/.test(w)) out.push(Number(w));
    else if (NUMBERS[w] !== undefined) out.push(NUMBERS[w]);
  }
  if (ONE_BEFORE_UNIT.test(text)) out.push(1);
  return out;
}

function saidAge(text: string, age: string): boolean {
  const a = ` ${normalise(age).replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ')} `;
  const said = new Set(numbersIn(text));
  const wanted = numbersIn(a);
  const months = [...a.matchAll(MONTHS)].map((m) => m[0]);
  if (wanted.length || months.length) return wanted.every((n) => said.has(n)) && months.every((m) => has(text, m));
  // no number at all ("a puppy", "young"): the caller's own words for it
  const words = a.trim().split(' ').filter((w) => w.length > 2 && !FILLER.has(w));
  return words.length > 0 && words.every((w) => has(text, w));
}

/** The first of the pet's details the model passed that the caller did not say, or null when every one was said. */
export function petFactNotSaid(state: CallState, args: { species?: unknown; sex?: unknown; birthday_or_age?: unknown }): PetFact | null {
  const text = evidence(state);
  if (typeof args.species === 'string' && args.species.trim() && !saidSpecies(text, args.species)) return 'species';
  if (typeof args.sex === 'string' && args.sex && !saidSex(text, args.sex)) return 'sex';
  if (typeof args.birthday_or_age === 'string' && args.birthday_or_age.trim() && !saidAge(text, args.birthday_or_age)) return 'age';
  return null;
}

/** Words that mark a short answer as one language or the other ("Es Sunny", "It's Sunny"). */
const MARKS: Record<Language, Set<string>> = {
  en: new Set(['is', "it's", 'its', 'name', 'named', 'called', 'my', 'the', 'yes', 'sorry', 'that', 'her', 'his', 'she', 'he']),
  es: new Set(['es', 'se', 'llama', 'llamo', 'nombre', 'perdon', 'si', 'eso', 'su', 'mi', 'la', 'el', 'ella', 'el']),
};

/**
 * Whether a pet's name was heard only in a short answer in another language than the one the assistant was speaking
 * ("Es Sunny." on an English call): confirmed with the caller before it is used (T11, a tester's call 2026-11-24: "Es
 * Sunny", "Perdón" and "Sí, eso" were all taken as answers). A name said in a sentence of the call's own language is not.
 */
export function nameHeardInFragment(state: CallState, name: string): boolean {
  const want = normalise(name).trim();
  if (!want) return false;
  const turns = state.turns.slice(state.newFromTurn);
  const carrying = turns.map((t, i) => ({ t, i })).filter(({ t }) => t.speaker === 'caller' && ` ${normalise(t.text).replace(/[^\p{L}\p{N}' ]+/gu, ' ')} `.includes(` ${want} `));
  if (!carrying.length) return false;
  return carrying.every(({ t, i }) => {
    const words = normalise(t.text).replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter((w) => w && !want.split(' ').includes(w));
    if (words.length > 3) return false;
    const asked = turns.slice(0, i).reverse().find((x) => x.speaker === 'agent');
    const spoken = asked ? languageAfterTurn(asked.text, LANGUAGES, state.language) : state.language;
    const other = LANGUAGES.find((l) => l !== spoken && words.some((w) => MARKS[l]?.has(w)));
    return !!other && !words.some((w) => MARKS[spoken]?.has(w));
  });
}
