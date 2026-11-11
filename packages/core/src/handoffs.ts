// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The handoff review loop (note 47; the one alpha exception, 2026-11-11). Each time the assistant hands a call to
 * the clinic's team (a request, a callback, a transfer, an emergency) or has no answer, a record of codes is kept, so
 * the Attendra team can judge whether the handoff was needed and improve the agent. One list of codes and labels for
 * the engine, its API and the back office (which shows the labels the API sends).
 */
export const HANDOFF_KINDS = ['request', 'callback', 'transfer', 'emergency', 'no_answer'] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

export const HANDOFF_REASONS = ['caller_asked_person', 'identity_not_verified', 'no_answer_in_clinic_info', 'policy_refusal', 'tool_error', 'out_of_scope', 'language', 'emergency'] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export const HANDOFF_VERDICTS = ['needed', 'not_needed', 'answer_wrong'] as const;
export type HandoffVerdict = (typeof HANDOFF_VERDICTS)[number];

export const HANDOFF_FIX_CATEGORIES = ['agent_rule', 'clinic_info_missing', 'bug'] as const;
export type HandoffFixCategory = (typeof HANDOFF_FIX_CATEGORIES)[number];

/** The words the back office shows for each code: staff only, English. */
export const HANDOFF_LABELS = {
  kind: { request: 'Request', callback: 'Callback', transfer: 'Transfer', emergency: 'Emergency', no_answer: 'No answer' },
  reason: {
    caller_asked_person: 'Caller asked for a person', identity_not_verified: 'Identity not verified', no_answer_in_clinic_info: 'No answer in clinic info',
    policy_refusal: 'Policy refusal', tool_error: 'Tool error', out_of_scope: 'Out of scope', language: 'Language', emergency: 'Emergency',
  },
  verdict: { needed: 'Needed', not_needed: 'Not needed', answer_wrong: 'Answer was wrong' },
  fixCategory: { agent_rule: 'Agent rule', clinic_info_missing: 'Clinic info missing', bug: 'Bug' },
} as const satisfies { kind: Record<HandoffKind, string>; reason: Record<HandoffReason, string>; verdict: Record<HandoffVerdict, string>; fixCategory: Record<HandoffFixCategory, string> };

/** One tool step before a handoff, as codes: the tool's name and its result code ('ok', or the refusal's error code). */
export interface HandoffStep { tool: string; result: string }

/** The tool steps kept with a handoff: the last ones before it. */
export const HANDOFF_STEPS_MAX = 8;
/** The Level 2 excerpt: the lines from about this long before the handoff to the handoff, at most HANDOFF_EXCERPT_LINES. */
export const HANDOFF_EXCERPT_MS = 30_000;
export const HANDOFF_EXCERPT_LINES = 6;

/** The names a call knows, by what they are: each is masked as its kind in an excerpt. */
export interface KnownNames { people: readonly string[]; pets: readonly string[]; vets: readonly string[] }

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_STOP = new Set(['dr', 'dra', 'mr', 'mrs', 'ms', 'the', 'and', 'de', 'la', 'el', 'del', 'los', 'las', 'y', 'van', 'von']);
/** Each word of each name, two letters or more, longest first, so "Mary Ann" is cut before "Ann". */
function nameWords(names: readonly string[]): string[] {
  const words = names.flatMap((n) => fold(n).split(/[\s,.'-]+/)).map((w) => w.trim()).filter((w) => w.length >= 2 && !NAME_STOP.has(w.toLowerCase()));
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** A street address: a house number and a street word ("1200 Larkspur Avenue"), or a Spanish street before its number ("calle Mayor 12"). */
const STREET = /\b\d{1,6}[a-z]?\s+(?:[a-z0-9'.-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|parkway|pkwy|highway|hwy|terrace|circle|cir|square|sq)\b\.?|\b(?:calle|avenida|avda|av|carrera|camino|paseo|plaza)\.?\s+(?:[a-z'.-]+\s+){1,4}\d{1,5}\b/gi;
/** Digits written as numbers, however spaced or punctuated, with at least 5 digits. */
const DIGITS = /\+?\(?\d[\d\s().-]{3,}\d/g;
const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  cero: '0', uno: '1', un: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9',
};
/** Digits said as words ("seven two zero five five five…", "siete dos cero…"), with "double"/"triple" before a digit. */
const SPOKEN = new RegExp(`\\b(?:(?:double|triple|doble|triple)\\s+)?(?:${Object.keys(DIGIT_WORDS).join('|')})\\b(?:[\\s,.-]+(?:(?:double|triple|doble)\\s+)?(?:${Object.keys(DIGIT_WORDS).join('|')})\\b){4,}`, 'gi');
const lastFour = (digits: string) => `…${digits.slice(-4)}`;
function spokenDigits(words: string): string {
  let out = '';
  let times = 1;
  for (const w of words.toLowerCase().split(/[\s,.-]+/).filter(Boolean)) {
    if (w === 'double' || w === 'doble') { times = 2; continue; }
    if (w === 'triple') { times = 3; continue; }
    out += (DIGIT_WORDS[w] ?? '').repeat(times);
    times = 1;
  }
  return out;
}

/**
 * A line of an excerpt with what identifies anyone cut out, BEFORE it is stored (note 47, Level 2 rule 3): the call's
 * known names as [name], [pet] and [vet]; every number of five digits or more, written or said, to its last 4; emails as
 * [email]; street addresses as [address]. English and Spanish. A test proves no known name or full number survives.
 */
export function maskExcerptLine(line: string, names: KnownNames): string {
  let t = fold(line);
  t = t.replace(EMAIL, '[email]');
  t = t.replace(STREET, '[address]');
  t = t.replace(SPOKEN, (m) => { const d = spokenDigits(m); return d.length >= 5 ? lastFour(d) : m; });
  t = t.replace(DIGITS, (m) => { const d = m.replace(/\D/g, ''); return d.length >= 5 ? lastFour(d) : m; });
  for (const [kind, list] of [['vet', names.vets], ['pet', names.pets], ['name', names.people]] as const) {
    for (const w of nameWords(list)) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(w)}(?![\\p{L}\\p{N}])`, 'giu'), `[${kind}]`);
  }
  return t;
}

/** One line of an excerpt as stored: who said it, and the masked words. */
export interface ExcerptLine { speaker: 'caller' | 'assistant'; text: string }

/** The excerpt around a handoff: the turns from HANDOFF_EXCERPT_MS before `atMs`, the last HANDOFF_EXCERPT_LINES of them, masked. */
export function handoffExcerpt(turns: readonly { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }[], atMs: number, names: KnownNames): ExcerptLine[] {
  return turns.filter((t) => t.endMs >= atMs - HANDOFF_EXCERPT_MS && t.startMs <= atMs && t.text.trim())
    .slice(-HANDOFF_EXCERPT_LINES)
    .map((t) => ({ speaker: t.speaker === 'agent' ? 'assistant' : 'caller', text: maskExcerptLine(t.text, names) }));
}
