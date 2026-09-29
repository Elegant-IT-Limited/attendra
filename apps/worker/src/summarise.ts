// SPDX-License-Identifier: AGPL-3.0-only
import { detectLanguage, LANGUAGES, PACKS } from '@attendra/core';
import { type CallForSummary, type CallSummary, INTENTS, SENTIMENTS } from '@attendra/db';
import type OpenAI from 'openai';
import { z } from 'zod';

/** An error whose message is a code, safe to log and to keep with a failed job: never content. */
export class JobError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'JobError'; }
}

/** What the model must return. The shape is checked again here, whatever the model says it did. */
export const SummaryOutput = z.object({
  summary: z.string().min(1).max(600),
  intent: z.enum(INTENTS),
  sentiment: z.enum(SENTIMENTS),
  needsReview: z.boolean(),
  reviewReason: z.string().min(1).max(200).nullable(),
  followUp: z.string().min(1).max(200).nullable(),
}).strict().refine((s) => !s.needsReview || s.reviewReason, 'a call that needs review says why');

// Strict structured output takes the shape without length limits; the limits are checked after.
const SHAPE = z.object({
  summary: z.string(), intent: z.enum(INTENTS), sentiment: z.enum(SENTIMENTS),
  needsReview: z.boolean(), reviewReason: z.string().nullable(), followUp: z.string().nullable(),
}).strict();
const JSON_SCHEMA = z.toJSONSchema(SHAPE) as Record<string, unknown>;
delete JSON_SCHEMA.$schema;

export interface Summariser {
  /** Recorded with each summary: the model's name, or "local". */
  readonly model: string;
  summarise(call: CallForSummary): Promise<CallSummary>;
}

export const SUMMARY_INSTRUCTIONS = [
  'You summarise one phone call to a medical clinic for the clinic\'s staff.',
  'Summarise only what was said and done on the call. Do not add medical advice, diagnoses, guesses about symptoms, or anything the caller did not say.',
  'Write in English, for staff, even when the call was in another language. Two or three plain sentences. Name no one except by their role (the caller, the assistant).',
  'intent is what the caller mainly wanted. sentiment is how the caller came across: calm, frustrated or distressed.',
  'Set needsReview when staff should look at the call: emergency language, a caller who could not be verified, a request the assistant could not complete, an upset caller, or anything unclear. Give the reason in one short sentence.',
  'followUp is one short action for staff, such as "Call the patient back about the refill", or null when nothing is needed.',
].join('\n');

function callText(call: CallForSummary, maxChars: number): string {
  const facts = [
    `Channel: ${call.channel}. Outcome: ${call.outcome ?? 'none'}. Emergency language: ${call.emergency ? 'yes' : 'no'}. Ended: ${call.closeReason ?? 'unknown'}.`,
    `Tools: ${call.actions.map((a) => `${a.tool}(${Object.entries(a.result).map(([k, v]) => `${k}=${String(v)}`).join(', ')})`).join('; ') || 'none'}.`,
    `Requests created for staff: ${call.tasks.map((t) => t.type).join(', ') || 'none'}.`,
  ].join('\n');
  let transcript = call.transcript.map((t) => `${t.speaker === 'caller' ? 'Caller' : 'Assistant'}: ${t.text}`).join('\n');
  // a cost ceiling on the input: a very long call keeps its start and its end
  if (transcript.length > maxChars) transcript = `${transcript.slice(0, maxChars / 2)}\n[...]\n${transcript.slice(-maxChars / 2)}`;
  return `${facts}\n\nTranscript:\n${transcript}`;
}

/** Emergency calls are always flagged, whatever the model decided. */
function enforce(call: CallForSummary, s: CallSummary): CallSummary {
  if (!call.emergency) return s;
  return { ...s, intent: 'emergency', needsReview: true, reviewReason: s.reviewReason ?? 'Emergency language on the call.' };
}

/**
 * The Responses API with strict structured output. store: false keeps the call
 * inside Zero Data Retention, the model comes from the environment, and each request
 * has a timeout and a ceiling on what it can cost: the transcript is capped, and so
 * is the output. pg-boss does the retrying, so the client does not.
 */
export class ModelSummariser implements Summariser {
  constructor(
    private readonly openai: Pick<OpenAI, 'responses'>,
    readonly model: string,
    private readonly limits = { timeoutMs: 30_000, maxOutputTokens: 500, maxTranscriptChars: 24_000 },
  ) {}

  async summarise(call: CallForSummary): Promise<CallSummary> {
    let res;
    try {
      res = await this.openai.responses.create({
        model: this.model, instructions: SUMMARY_INSTRUCTIONS, input: callText(call, this.limits.maxTranscriptChars),
        store: false, max_output_tokens: this.limits.maxOutputTokens,
        text: { format: { type: 'json_schema', name: 'call_summary', strict: true, schema: JSON_SCHEMA } },
      }, { timeout: this.limits.timeoutMs, maxRetries: 0 });
    } catch (err) {
      // the status only: an API error can echo the request, and the request is a transcript
      const status = (err as { status?: number }).status;
      throw new JobError(status ? `summary_model_http_${status}` : 'summary_model_unreachable');
    }
    if (res.status === 'incomplete') throw new JobError('summary_model_incomplete');
    let json: unknown;
    try { json = JSON.parse(res.output_text ?? ''); } catch { throw new JobError('summary_not_json'); }
    const parsed = SummaryOutput.safeParse(json);
    if (!parsed.success) throw new JobError('summary_invalid');
    return enforce(call, parsed.data);
  }
}

const said = (call: CallForSummary, code: string) => call.actions.some((a) => a.result.error === code);
const ran = (call: CallForSummary, tool: string) => call.actions.some((a) => a.tool === tool);

/**
 * A summary written from the call's facts, with no model: what the tools did, the
 * outcome and the flags. It is deterministic, so the demo and the tests read the same
 * every time, and it is what runs when no OpenAI key is set.
 */
export class LocalSummariser implements Summariser {
  readonly model = 'local';

  async summarise(call: CallForSummary): Promise<CallSummary> {
    const verified = call.actions.some((a) => a.result.verified === true);
    const triedToVerify = ran(call, 'verify_caller');
    const transferred = call.actions.some((a) => typeof a.result.transferring === 'string');
    const task = call.tasks[0]?.type;
    const callerWords = call.transcript.filter((t) => t.speaker === 'caller').map((t) => t.text).join(' ');
    const language = detectLanguage(callerWords, LANGUAGES, 'en');

    const intent: CallSummary['intent'] = call.emergency ? 'emergency'
      : call.outcome === 'booked' ? 'book' : call.outcome === 'rescheduled' ? 'reschedule' : call.outcome === 'cancelled' ? 'cancel'
        : task === 'refill' ? 'refill' : task === 'callback' ? 'callback'
          : ran(call, 'find_slots') || ran(call, 'propose_booking') ? 'book'
            : ran(call, 'get_clinic_info') ? 'question' : 'other';
    const sentiment: CallSummary['sentiment'] = call.emergency ? 'distressed'
      : said(call, 'too_many_attempts') || call.actions.filter((a) => a.result.error === 'not_verified').length >= 2 ? 'frustrated' : 'calm';

    const sentences: string[] = [];
    if (language !== 'en') sentences.push(`The caller spoke ${PACKS[language].name}.`);
    if (triedToVerify) sentences.push(verified ? 'The caller was verified by name and date of birth.' : 'The caller could not be verified.');
    if (call.emergency) {
      sentences.push('The caller used emergency language, and the assistant stopped and gave the emergency number.');
      if (transferred) sentences.push('The call was transferred to the on-call line.');
    } else if (call.outcome === 'booked') sentences.push(`The assistant booked an appointment${call.actions.some((a) => a.result.booked === true) ? ' after the caller confirmed it' : ''}.`);
    else if (call.outcome === 'rescheduled') sentences.push('The assistant moved an existing appointment to a new time after the caller confirmed it.');
    else if (call.outcome === 'cancelled') sentences.push('The assistant cancelled an appointment after the caller confirmed it.');
    else if (task === 'refill') sentences.push('The assistant took a prescription refill request for the care team to review.');
    else if (task === 'callback') sentences.push('The assistant took a request for the clinic to call back.');
    else if (transferred) sentences.push('The call was transferred to a person.');
    else if (ran(call, 'get_clinic_info')) sentences.push('The caller asked about the clinic, and the assistant answered from the clinic\'s own information.');
    else sentences.push('The call ended with nothing booked or requested.');
    if (!call.emergency && said(call, 'no_clear_yes')) sentences.push('The caller did not clearly confirm a change, so nothing was changed at that point.');

    const [needsReview, reviewReason, followUp]: [boolean, string | null, string | null] =
      call.emergency ? [true, 'Emergency language on the call.', 'Check the call and whether anyone should contact the caller.']
        : said(call, 'needs_staff') ? [true, 'Two patient records share the caller\'s name and date of birth.', 'Confirm which patient called and call them back.']
          : said(call, 'too_many_attempts') ? [true, 'The caller could not be verified after three tries.', 'Call the caller back to confirm who they are.']
            : call.closeReason === 'error' ? [true, 'The call ended on an error.', 'Check whether the caller needs a call back.']
              : task === 'refill' ? [false, null, 'Review the refill request and call the patient if anything is unclear.']
                : task === 'callback' ? [false, null, 'Call the caller back.']
                  : [false, null, null];
    return { summary: sentences.slice(0, 3).join(' '), intent, sentiment, needsReview, reviewReason, followUp };
  }
}
