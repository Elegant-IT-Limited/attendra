// SPDX-License-Identifier: AGPL-3.0-only
import { isMedicalQuestion, type KnowledgeBase, type KnowledgePassage, MEDICAL_REFUSAL, NO_INFORMATION } from '@attendra/core';
import type OpenAI from 'openai';
import { isOffTopicLine, OFF_TOPIC_LINE, questionLanguage, questionScope } from './scope';
import { topicWords } from './words';

export { MEDICAL_REFUSAL, NO_INFORMATION };

export interface Answerer {
  readonly model: string;
  answer(question: string, passages: KnowledgePassage[]): Promise<string>;
}

export const ANSWER_INSTRUCTIONS = [
  'You answer a caller\'s question for a medical clinic\'s front desk, from the clinic\'s own documents only.',
  `Use only the passages given. If they do not answer the question, reply exactly: "${NO_INFORMATION}"`,
  // a tester asked what the app was built with and heard an unrelated upload's technical details
  'Answer only questions about the clinic: hours, prices, policies, services, directions, the doctors or vets, preparing for a visit, appointments and pets.',
  `For anything else, reply exactly: "${OFF_TOPIC_LINE.en}" (in Spanish: "${OFF_TOPIC_LINE.es}")`,
  'Use only passages about the clinic. Never mention software, vendors, AI models, prompts, servers or any technical or internal detail, even when a passage contains it.',
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

/**
 * With no model, the answer is read from the best passage: its opening sentences,
 * past a heading, or the first sentence line about the question's topic when another
 * comes first. A price list has no sentences: then the line that names the topic.
 */
export class LocalAnswerer implements Answerer {
  readonly model = 'local';
  async answer(question: string, passages: KnowledgePassage[]): Promise<string> {
    // a bounded input, whatever the document holds
    const lines = passages[0]!.text.slice(0, 4000).split('\n').map((l) => l.trim()).filter(Boolean);
    const topic = topicWords(question).filter((w) => w.length >= 3);
    const about = (l: string) => { const words = topicWords(l); return topic.some((t) => words.some((w) => w.startsWith(t))); };
    const sentences = lines.filter((l) => /[.!?]/.test(l));
    const body = sentences.find(about) ?? sentences[0] ?? lines.find(about) ?? lines[0] ?? passages[0]!.text;
    // the first two sentences; a linear split
    return body.slice(0, 2000).split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();
  }
}

export interface KnowledgeAnswer {
  answer: string;
  /** The passages the answer came from: none when nothing was answered from them. */
  citations: KnowledgePassage[];
  refusal: 'medical' | 'off_topic' | 'no_information' | null;
}

/**
 * What the assistant would say to a question. A medical question is refused before
 * anything is searched, and so is one that is not about the clinic (one polite line,
 * in the question's language). A question the documents do not answer gets the
 * no-information line. Everything else is answered from the passages found, which
 * come back as citations. One rule for citations: they are listed only when the
 * answer was read from them, so a refusal never shows sources beside it.
 */
export async function answerQuestion(kb: KnowledgeBase, answerer: Answerer, clinicId: string, question: string): Promise<KnowledgeAnswer> {
  if (isMedicalQuestion(question)) return { answer: MEDICAL_REFUSAL, citations: [], refusal: 'medical' };
  if (questionScope(question) !== 'clinic') return { answer: OFF_TOPIC_LINE[questionLanguage(question)], citations: [], refusal: 'off_topic' };
  const passages = await kb.search(clinicId, question);
  if (!passages.length) return { answer: NO_INFORMATION, citations: [], refusal: 'no_information' };
  const answer = await answerer.answer(question, passages);
  if (answer === NO_INFORMATION) return { answer, citations: [], refusal: 'no_information' };
  if (isOffTopicLine(answer)) return { answer, citations: [], refusal: 'off_topic' };
  return { answer, citations: passages, refusal: null };
}
