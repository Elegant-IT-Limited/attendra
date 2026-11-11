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

/** A word that is an email address once the punctuation around it is set aside: "linh@example.com." */
const EMAIL_WORD = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
/** Each email among the words as "[email]", keeping the punctuation after it. */
function maskEmails(pieces: Piece[]): Piece[] {
  return pieces.map((p) => {
    if (!p.word.includes('@')) return p;
    const trail = p.word.match(/[,;:!?)."']*$/)![0];
    const core = p.word.slice(p.word.startsWith('(') || p.word.startsWith('"') ? 1 : 0, p.word.length - trail.length);
    return EMAIL_WORD.test(core) ? { word: `[email]${trail}`, gap: p.gap } : p;
  });
}
/** Street words after a house number ("1200 Larkspur Avenue"), and Spanish street words before a name and a number ("calle Mayor 12"). */
const STREET_AFTER = new Set(['street', 'st', 'avenue', 'ave', 'road', 'rd', 'boulevard', 'blvd', 'lane', 'ln', 'drive', 'dr', 'court', 'ct', 'way', 'place', 'pl', 'parkway', 'pkwy', 'highway', 'hwy', 'terrace', 'circle', 'cir', 'square', 'sq']);
const STREET_BEFORE = new Set(['calle', 'avenida', 'avda', 'av', 'carrera', 'camino', 'paseo', 'plaza']);
const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  cero: '0', uno: '1', un: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9',
};
const REPEAT: Record<string, number> = { double: 2, doble: 2, triple: 3 };
const lastFour = (digits: string) => `…${digits.slice(-4)}`;

/**
 * A line as words and the space between them, so numbers, spoken digits and addresses are found by walking the words
 * once: no regular expression with nested repeats runs on what a caller said (CodeQL; a long line stays linear).
 */
type Piece = { word: string; gap: string };
function piecesOf(line: string): Piece[] {
  const out: Piece[] = [];
  for (const m of line.matchAll(/(\S+)(\s*)/g)) out.push({ word: m[1]!, gap: m[2]! });
  return out;
}
const bare = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}+(]+|[^\p{L}\p{N}]+$/gu, '');
const digitsOf = (w: string) => w.replace(/\D/g, '');
/** A word that is part of a written number: digits with + ( ) . - between them, or only those marks. */
const NUMBERISH_SHAPE = /^[+(]?[\d().-]+[,.;:!?)]*$/;
const isNumberish = (w: string) => NUMBERISH_SHAPE.test(w) && /\d/.test(w);

/** Every run of words that writes or says five digits or more, cut to its last four ("…0172"). */
function maskNumbers(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  while (i < pieces.length) {
    let j = i;
    let digits = '';
    let spoken = false;
    let times = 1;
    while (j < pieces.length) {
      const w = bare(pieces[j]!.word);
      if (isNumberish(pieces[j]!.word)) { digits += digitsOf(pieces[j]!.word); j++; continue; }
      if (w in REPEAT && j + 1 < pieces.length && bare(pieces[j + 1]!.word) in DIGIT_WORDS) { times = REPEAT[w]!; j++; continue; }
      if (w in DIGIT_WORDS && (spoken || j + 1 < pieces.length)) {
        // a lone "one" or "o" is a word, not a number: spoken digits count only in a run
        digits += DIGIT_WORDS[w]!.repeat(times); times = 1; spoken = true; j++; continue;
      }
      break;
    }
    if (j > i && digits.length >= 5) {
      const trail = pieces[j - 1]!.word.match(/[^\p{L}\p{N}]*$/u)![0].replace(/[\d()+-]/g, '');
      out.push({ word: `${lastFour(digits)}${trail}`, gap: pieces[j - 1]!.gap });
      i = j;
    } else {
      out.push(pieces[i]!);
      i++;
    }
  }
  return out;
}

/** House number, up to four words, a street word; or a Spanish street word, up to four words, a number: "[address]". */
function maskStreets(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  while (i < pieces.length) {
    let end = -1;
    if (/^\d{1,6}[a-z]?$/i.test(bare(pieces[i]!.word))) {
      for (let k = i + 1; k < Math.min(pieces.length, i + 6); k++) if (STREET_AFTER.has(bare(pieces[k]!.word))) { end = k; break; }
    } else if (STREET_BEFORE.has(bare(pieces[i]!.word))) {
      for (let k = i + 2; k < Math.min(pieces.length, i + 6); k++) if (/^\d{1,5}$/.test(bare(pieces[k]!.word))) { end = k; break; }
    }
    if (end < 0) { out.push(pieces[i]!); i++; continue; }
    const trail = pieces[end]!.word.match(/[^\p{L}\p{N}]*$/u)![0];
    out.push({ word: `[address]${trail}`, gap: pieces[end]!.gap });
    i = end + 1;
  }
  return out;
}

/**
 * A line of an excerpt with what identifies anyone cut out, BEFORE it is stored (note 47, Level 2 rule 3): the call's
 * known names as [name], [pet] and [vet]; every number of five digits or more, written or said, to its last 4; emails as
 * [email]; street addresses as [address]. English and Spanish. A test proves no known name or full number survives.
 */
export function maskExcerptLine(line: string, names: KnownNames): string {
  const lead = /^\s*/.exec(line)![0];
  const pieces = maskNumbers(maskStreets(maskEmails(piecesOf(fold(line)))));
  let t = lead + pieces.map((p) => p.word + p.gap).join('');
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
