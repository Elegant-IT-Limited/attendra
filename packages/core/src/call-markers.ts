// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Two markers of how a call felt to the caller, worked out from its turns when it closes (CALL-3, batch 4b) and kept on
 * the call row (migration 0055): the longest wait after they spoke, and how often the assistant asked something again.
 * The scripted evals fail a run on the same repeat rule (no_repeated_questions), so a call and an eval count alike.
 */

/** One turn of a call, on the call's own timeline. */
export interface MarkedTurn { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }

/**
 * The longest the caller waited in silence after speaking: from the end of a caller turn to the start of the assistant's
 * next turn. Null when no caller turn was answered. A reply that started before the caller finished (they talked over
 * it) is no wait.
 */
export function maxGapMs(turns: readonly MarkedTurn[]): number | null {
  let max: number | null = null;
  for (let i = 1; i < turns.length; i++) {
    const [before, reply] = [turns[i - 1]!, turns[i]!];
    if (before.speaker !== 'caller' || reply.speaker !== 'agent') continue;
    const gap = Math.round(reply.startMs - before.endMs);
    if (gap >= 0 && (max === null || gap > max)) max = gap;
  }
  return max;
}

/** The questions in a line: each sentence that ends with a question mark. */
export function questionsIn(line: string): string[] {
  return line.split(/(?<=[.!?])\s+/).map((q) => q.trim()).filter((q) => q.endsWith('?'));
}

/** Two questions are the same question when they are the same words (case, punctuation and accents aside); a confirmation asked once per change is not. */
export function sameQuestion(a: string, b: string): boolean {
  const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '\'').split(/[^\p{L}\p{N}']+/u).filter(Boolean).join(' ');
  // the closing and confirming questions, and "how can I help?" once at the greeting and once after finding the caller, are no repeat
  const closing = /anything else|is that right|shall i book|is that correct|book (it|that)\?|how can i help|en qu[eé] (le )?puedo ayudar|algo m[aá]s|le reservo la cita|es correcto/i;
  if (closing.test(a) && closing.test(b)) return false;
  const [x, y] = [norm(a), norm(b)];
  return x.length >= 12 && x === y;
}

/** The caller asked to hear it again ("say that again", "sorry?"): a question asked again after that is no repeat. */
const ASKED_TO_REPEAT = /\b(again|repeat|what\?|sorry\?|pardon|didn't catch|did not catch|say that)\b/;

/**
 * Each time the assistant asked a question it had already asked, with the caller speaking in between: the first asking
 * and the repeat. Not a repeat: a question asked again because the caller asked to hear it again, or the same question
 * after a new offer ("Which time works for you?" after a new set of times: the reply around it differs). Each repeat
 * is listed once, with the first earlier question it repeats. Lines of any other speaker (an eval's instructions) are
 * neither a question nor an answer.
 */
export function repeatedQuestions(lines: readonly { speaker: 'caller' | 'agent' | (string & {}); text: string }[]): { first: string; again: string }[] {
  const asked: { q: string; at: number }[] = [];
  lines.forEach((l, at) => { if (l.speaker === 'agent') for (const q of questionsIn(l.text)) asked.push({ q, at }); });
  const around = (at: number, q: string) => lines[at]!.text.replace(q, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const repeats: { first: string; again: string }[] = [];
  for (let j = 1; j < asked.length; j++) {
    for (let i = 0; i < j; i++) {
      const between = lines.slice(asked[i]!.at + 1, asked[j]!.at).filter((l) => l.speaker === 'caller').map((l) => l.text.toLowerCase());
      const askedToRepeat = between.some((t) => ASKED_TO_REPEAT.test(t));
      const newOffer = around(asked[i]!.at, asked[i]!.q) !== around(asked[j]!.at, asked[j]!.q) && around(asked[j]!.at, asked[j]!.q).length > 12;
      if (between.length && !askedToRepeat && !newOffer && sameQuestion(asked[i]!.q, asked[j]!.q)) {
        repeats.push({ first: asked[i]!.q, again: asked[j]!.q });
        break;
      }
    }
  }
  return repeats;
}
