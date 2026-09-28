// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Answers from the clinic's own FAQ, by word overlap. It is deliberately simple for
 * v0.1: a clinic's FAQ is a few dozen entries, the answer must be the clinic's
 * words, not a model's paraphrase of the internet, and a miss is safe (the agent
 * offers a callback). pgvector retrieval over longer documents is on the roadmap.
 */
const STOP = new Set(['the', 'a', 'an', 'do', 'you', 'i', 'my', 'is', 'are', 'what', 'how', 'can', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'your', 'me', 'we', 'it', 'if', 'there']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

export function answerFromFaqs<T extends { id: string; question: string; answer: string }>(faqs: T[], question: string, minOverlap = 1): T | null {
  const asked = new Set(words(question));
  let best: { faq: T; score: number } | null = null;
  for (const faq of faqs) {
    const score = words(`${faq.question}`).filter((w) => asked.has(w)).length;
    if (score >= minOverlap && (!best || score > best.score)) best = { faq, score };
  }
  return best?.faq ?? null;
}
