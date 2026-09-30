// SPDX-License-Identifier: AGPL-3.0-only
import type OpenAI from 'openai';

export interface Line { speaker: 'caller' | 'assistant'; text: string }

/**
 * Whoever plays the patient. A text caller now; a voice caller later speaks the same
 * lines through text to speech and hears the assistant through speech to text,
 * behind this same interface.
 */
export interface SimulatedCaller {
  /** The caller's next line, given the call so far. `hangup` ends the call after it. */
  next(call: Line[]): Promise<{ text: string; hangup: boolean }>;
}

export interface Persona { id: string; clinic: 'maple' | 'dhanmondi'; caller_number: string | null; persona: string; goal: string; expect: string[] }

const HANGUP = '[HANGUP]';

/**
 * A model plays the patient, from the persona and the goal. store is off, the model
 * comes from ATTENDRA_SIM_MODEL, and each line has a timeout and a short ceiling.
 */
export class ModelCaller implements SimulatedCaller {
  constructor(private readonly openai: Pick<OpenAI, 'responses'>, readonly model: string, private readonly persona: Persona, private readonly limits = { timeoutMs: 20_000, maxOutputTokens: 150 }) {}

  async next(call: Line[]) {
    const res = await this.openai.responses.create({
      model: this.model, store: false, max_output_tokens: this.limits.maxOutputTokens,
      instructions: [
        'You are playing a patient phoning a medical clinic, to test its assistant. Stay in character.',
        `Who you are: ${this.persona.persona}`, `What you want: ${this.persona.goal}`,
        'Say one short line at a time, the way people talk on the phone. Answer what you are asked.',
        `When your goal is done, or the assistant has done all it can, say goodbye and end your line with ${HANGUP}.`,
      ].join('\n'),
      input: call.length ? call.map((l) => `${l.speaker === 'caller' ? 'You' : 'Assistant'}: ${l.text}`).join('\n') : 'The assistant has just answered the phone.',
    }, { timeout: this.limits.timeoutMs, maxRetries: 1 });
    const text = (res.output_text ?? '').trim();
    return { text: text.replace(HANGUP, '').trim(), hangup: text.includes(HANGUP) };
  }
}

/** A caller that says fixed lines, for tests. */
export class ScriptedCaller implements SimulatedCaller {
  private i = 0;
  constructor(private readonly lines: string[]) {}
  async next() {
    const text = this.lines[this.i++] ?? 'Thank you, goodbye.';
    return { text, hangup: this.i >= this.lines.length };
  }
}
