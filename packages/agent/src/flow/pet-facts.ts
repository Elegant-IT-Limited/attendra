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

/** A sentence as the checks read it: normalised, with spaces around it, digits and decimals kept ("1.5"). */
const flat = (text: string) => ` ${normalise(text).replace(/(\d)[.,](\d)/g, '$1_$2').replace(/[^\p{L}\p{N}'_ ]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
const sentences = (text: string) => text.split(/(?<=[.!?¿¡])\s+|(?<=[.!?])(?=\S)/).map((s) => s.trim()).filter(Boolean);

/**
 * The caller's words since the last pet was found or added, sentence by sentence, and each QUESTION a clear yes
 * answered ("Is Tango a cat?" "Yes."): never a statement the caller only acknowledged ("Got it, Tango is a cat."
 * "Okay."), and never a choice ("a boy or a girl?"), which a yes answers neither way (reviewer, T1).
 */
function evidence(state: CallState): string[] {
  const turns = state.turns.slice(state.newFromTurn);
  const out: string[] = [];
  turns.forEach((t, i) => {
    if (t.speaker !== 'caller') return;
    out.push(...sentences(t.text).map(flat));
    const asked = turns.slice(0, i).reverse().find((x) => x.speaker === 'agent');
    if (!asked || !isClearYes(t.text, LANGUAGES)) return;
    const question = sentences(asked.text).filter((s) => /\?\s*$/.test(s)).at(-1);
    if (question && !/\b(?:or|o)\b/i.test(normalise(question))) out.push(flat(question));
  });
  return out;
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

// the pronouns; in Spanish a pet's sex is also in the word said of it ("es nueva", "es nuevo"): FEMALE_WORD, MALE_WORD
const FEMALE = /\b(?:she|her|hers|she's|ella)\b/;
const MALE = /\b(?:he|him|his|he's)\b/;
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

function saidAge(sentencesSaid: string[], age: string): boolean {
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
  if (typeof args.birthday_or_age === 'string' && args.birthday_or_age.trim() && !saidAge(said, args.birthday_or_age)) return 'age';
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
