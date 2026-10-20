// SPDX-License-Identifier: AGPL-3.0-only
import type OpenAI from 'openai';
import type { Scenario } from './scenario';
import type { FollowUp, ScenarioResult } from './simulator';

const HANGUP = '[HANGUP]';

/**
 * Live evals only: after a scenario's opening line, a model plays the caller, answering
 * the planner's questions from what the caller already said and the scenario's facts, in
 * whatever order the planner asks them, so a careful planner is not marked as an
 * abandoned call. It never brings a new request. store is off.
 */
export function modelFollowUp(openai: Pick<OpenAI, 'responses'>, model: string): FollowUp {
  // the cap counts the model's reasoning too, so a small one can leave the line empty and end the call
  const ask = async (scenario: Scenario, transcript: ScenarioResult['transcript']) => {
    const res = await openai.responses.create({
      model, store: false, max_output_tokens: 1_000,
      instructions: [
        'You are the caller in a test of a clinic\'s phone assistant. Stay in character and keep to the situation.',
        `The situation: ${scenario.title}`,
        `What you know, besides what you already said: ${scenario.facts}`,
        'Answer the assistant\'s last question in one short line, as people talk on the phone, using only what you know. If you do not know, say so.',
        'If the assistant reads back what you asked for, say yes. Never ask for anything new.',
        `When your request is done, or the assistant says someone will call you back, say thanks and goodbye and end with ${HANGUP}.`,
      ].join('\n'),
      input: transcript.filter((l) => l.speaker !== 'instruction').map((l) => `${l.speaker === 'caller' ? 'You' : 'Assistant'}: ${l.text}`).join('\n'),
    }, { timeout: 20_000, maxRetries: 1 });
    return (res.output_text ?? '').trim();
  };
  return async (scenario: Scenario, transcript: ScenarioResult['transcript']) => {
    // an empty answer is asked for once more
    const text = (await ask(scenario, transcript)) || (await ask(scenario, transcript));
    return { text: text.replace(HANGUP, '').trim(), hangup: text.includes(HANGUP) };
  };
}
