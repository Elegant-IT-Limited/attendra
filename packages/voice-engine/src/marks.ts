// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The moments of a call's setup, from the webhook to the assistant's first words, each
 * kept once. One log line at the end says how long each step took, so a slow greeting
 * (6 to 13 s on real phone calls, 2026-10-29) can be read off without guessing.
 */
export const SETUP_STEPS = [
  'webhook', 'accept_sent', 'accepted', 'call_opened', 'attached', 'history', 'runner_started',
  'sideband_open', 'session_started', 'opening_sent', 'nudged', 'first_audio', 'first_words',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export class CallMarks {
  private readonly at = new Map<SetupStep, number>();

  /** `t0` is when the call reached us: the webhook delivery, or the browser's request. */
  constructor(readonly t0 = Date.now()) {
    this.at.set('webhook', t0);
  }

  /** The first time a step is marked counts; a second mark (a sideband that reconnected) changes nothing. */
  mark(step: SetupStep, at = Date.now()) {
    if (!this.at.has(step)) this.at.set(step, at);
  }

  has(step: SetupStep) {
    return this.at.has(step);
  }

  /** Milliseconds from the webhook to the step; null when it never happened. */
  ms(step: SetupStep): number | null {
    const t = this.at.get(step);
    return t === undefined ? null : t - this.t0;
  }

  /**
   * Every step in milliseconds from the webhook, plus the two that matter to a caller: from the call
   * connecting (the accept answered) to the first audio, and to the first words.
   */
  line(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const s of SETUP_STEPS) out[`${s}_ms`] = this.ms(s);
    const accepted = this.ms('accepted');
    const since = (step: SetupStep) => { const t = this.ms(step); return accepted === null || t === null ? null : t - accepted; };
    out.connected_to_first_audio_ms = since('first_audio');
    out.connected_to_first_words_ms = since('first_words');
    return out;
  }
}
