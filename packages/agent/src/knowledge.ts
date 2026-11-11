// SPDX-License-Identifier: AGPL-3.0-only
import { normalise } from '@attendra/core';

/**
 * Answers from the clinic's own FAQ, by word overlap. It is deliberately simple for
 * v0.1: a clinic's FAQ is a few dozen entries, the answer must be the clinic's
 * words, not a model's paraphrase of the internet, and a miss is safe (the agent
 * offers a callback). pgvector retrieval over longer documents is on the roadmap.
 */
const STOP = new Set([
  'the', 'a', 'an', 'do', 'you', 'i', 'my', 'is', 'are', 'what', 'how', 'can', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'your', 'me', 'we', 'it', 'if', 'there',
  'que', 'los', 'las', 'una', 'por', 'para', 'con', 'como', 'donde', 'cuando', 'ustedes', 'tienen', 'mi', 'mis',
].map(normalise));
// any script: letters, marks and digits make a word; Latin accents are dropped so "cita" meets "cíta"
// a light stem, so "parking" meets "park" and "located" meets "location"
const stem = (w: string) => (w.length > 5 ? w.replace(/(ing|ies|ied|ed|es|s)$/, '') : w.length > 4 ? w.replace(/s$/, '') : w);
const words = (s: string) => normalise(s).replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);

/**
 * An answer that only says the clinic's website has none ("The website does not specify payment methods…"), saved by a
 * website import before it left such questions out (note 49 B5; the cloud's importer has the same words): never said to
 * a caller. The question is treated as not answered.
 */
const NON_ANSWER = /\b(?:the |this )?(?:website|web site|site|page|text)\b[^.]{0,40}\b(?:does not|doesn'?t|did not|didn'?t|is not|isn'?t|has no|gives no|provides no)\b[^.]{0,20}\b(?:specify|specified|provide|provided|mention|mentioned|say|state|stated|list|listed|include|included|contain|give|clear|available|information|details?)\b|\bno (?:information|details) (?:is |are )?(?:given|provided|available|listed|stated|mentioned)\b|\bnot (?:specified|mentioned|stated|provided|listed) (?:on|in) the (?:website|site|page)\b|\b(?:el sitio|la pagina|el sitio web)\b[^.]{0,40}\bno (?:especifica|menciona|indica|dice|incluye|proporciona)\b/i;
export const isNonAnswer = (answer: string) => NON_ANSWER.test(normalise(answer));

export function answerFromFaqs<T extends { id: string; question: string; answer: string }>(faqs: T[], question: string, minOverlap = 1): T | null {
  const asked = new Set(words(question));
  let best: { faq: T; score: number } | null = null;
  for (const faq of faqs) {
    if (isNonAnswer(faq.answer)) continue;
    const score = words(`${faq.question}`).filter((w) => asked.has(w)).length;
    if (score >= minOverlap && (!best || score > best.score)) best = { faq, score };
  }
  return best?.faq ?? null;
}
