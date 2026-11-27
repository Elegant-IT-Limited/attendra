// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lines joined to be said in one breath, and the assistant's words as they are recorded (T9, a tester's call
 * 2026-11-24): "One moment. One moment.", a sentence said twice in one turn, and "wrap up smoothly.This demo call ends".
 */

/**
 * A space after a sentence that ends straight into the next one ("smoothly.This"): only after a word of two lower-case
 * letters or more, before a capital and a lower-case letter, so "Dr.Ruiz", "9.50", "U.S.A." and "example.com" stay.
 */
export function spacedSentences(text: string): string {
  return text.replace(/(\p{Ll}{2,}[.!?])(?=\p{Lu}\p{Ll})/gu, '$1 ');
}

const sentencesOf = (text: string) => spacedSentences(text.trim()).split(/(?<=[.!?])\s+(?=[\p{Lu}¿¡"“])/u).map((s) => s.trim()).filter(Boolean);
const sameWords = (a: string, b: string) => {
  const w = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return w(a) !== '' && w(a) === w(b);
};

/** The parts to say, in order, each sentence once (the same sentence twice in a row is said once), spaced. */
export function joinSaid(...parts: (string | null | undefined)[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (!part?.trim()) continue;
    for (const s of sentencesOf(part)) if (!out.length || !sameWords(out.at(-1)!, s)) out.push(s);
  }
  return out.join(' ');
}
