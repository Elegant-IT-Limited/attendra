// SPDX-License-Identifier: AGPL-3.0-only
import { isMedicalQuestion, type KnowledgeBase, type KnowledgePassage, MEDICAL_REFUSAL, NO_INFORMATION } from '@attendra/core';
import type OpenAI from 'openai';

export { MEDICAL_REFUSAL, NO_INFORMATION };

export interface Answerer {
  readonly model: string;
  answer(question: string, passages: KnowledgePassage[]): Promise<string>;
}

export const ANSWER_INSTRUCTIONS = [
  'You answer a caller\'s question for a medical clinic\'s front desk, from the clinic\'s own documents only.',
  `Use only the passages given. If they do not answer the question, reply exactly: "${NO_INFORMATION}"`,
  'Never give medical advice, doses, or anything a clinician should say. Two short sentences at most, plain words, no lists.',
].join('\n');

/** The Responses API with store off, a timeout and a ceiling on the output. */
export class ModelAnswerer implements Answerer {
  constructor(private readonly openai: Pick<OpenAI, 'responses'>, readonly model: string, private readonly limits = { timeoutMs: 20_000, maxOutputTokens: 200 }) {}

  async answer(question: string, passages: KnowledgePassage[]): Promise<string> {
    const input = `Question: ${question}\n\n${passages.map((p, i) => `Passage ${i + 1} (${p.title}):\n${p.text}`).join('\n\n')}`;
    const res = await this.openai.responses.create({ model: this.model, instructions: ANSWER_INSTRUCTIONS, input, store: false, max_output_tokens: this.limits.maxOutputTokens }, { timeout: this.limits.timeoutMs, maxRetries: 0 });
    return res.output_text?.trim() || NO_INFORMATION;
  }
}

/** With no model, the answer is the best passage's opening, as the assistant would read from it. */
export class LocalAnswerer implements Answerer {
  readonly model = 'local';
  async answer(_question: string, passages: KnowledgePassage[]): Promise<string> {
    const lines = passages[0]!.text.split('\n').filter((l) => l.trim());
    // the opening sentence line, past a heading ("Parking"), which has no sentence end
    const body = lines.find((l) => /[.!?]/.test(l)) ?? lines[0] ?? passages[0]!.text;
    // the first two sentences; a linear split, and a bounded input, whatever the document holds
    return body.slice(0, 2000).split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();
  }
}

export interface KnowledgeAnswer {
  answer: string;
  citations: KnowledgePassage[];
  refusal: 'medical' | 'no_information' | null;
}

/**
 * What the assistant would say to a question: a medical question is refused before
 * anything is searched, a question the documents do not answer gets the
 * no-information line, and everything else is answered from the passages found,
 * which come back as citations.
 */
export async function answerQuestion(kb: KnowledgeBase, answerer: Answerer, clinicId: string, question: string): Promise<KnowledgeAnswer> {
  if (isMedicalQuestion(question)) return { answer: MEDICAL_REFUSAL, citations: [], refusal: 'medical' };
  const passages = await kb.search(clinicId, question);
  if (!passages.length) return { answer: NO_INFORMATION, citations: [], refusal: 'no_information' };
  const answer = await answerer.answer(question, passages);
  return { answer, citations: passages, refusal: answer === NO_INFORMATION ? 'no_information' : null };
}
