// SPDX-License-Identifier: AGPL-3.0-only
import { normalise } from '@attendra/core';

/** Words that say nothing about the topic, in the languages the assistant speaks. A question made of only these finds nothing. */
const STOP = new Set([
  'the', 'a', 'an', 'do', 'does', 'did', 'you', 'your', 'i', 'my', 'me', 'we', 'our', 'is', 'are', 'was', 'be', 'can', 'could', 'would', 'should', 'will', 'what', 'when',
  'where', 'which', 'who', 'how', 'why', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'it', 'if', 'there', 'have', 'has', 'any', 'about', 'with', 'from', 'this', 'that',
  'please', 'tell', 'know', 'need', 'want', 'get', 'there', 'is', 'am', 'so', 'just', 'like',
  'el', 'la', 'los', 'las', 'de', 'del', 'que', 'por', 'para', 'con', 'una', 'uno', 'un', 'es', 'y', 'o', 'en', 'se', 'mi', 'su', 'hay', 'como', 'donde', 'cuando', 'tienen', 'puedo', 'esta', 'estan', 'son', 'al',
].map(normalise));

/** The topic words of a question, for the full-text search. */
export const topicWords = (question: string) => normalise(question).split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));
