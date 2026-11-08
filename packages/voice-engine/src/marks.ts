// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The moments of a call's setup, from the webhook to the assistant's first words, each
 * kept once. One log line at the end says how long each step took, so a slow greeting
 * (6 to 13 s on real phone calls, 2026-10-29) can be read off without guessing.
 */
export const SETUP_STEPS = [
  'webhook', 'accept_sent', 'accepted', 'call_opened', 'attached', 'history', 'runner_started',
  'sideband_open', 'transport_answered', 'session_started', 'opening_sent', 'nudged', 'first_audio', 'first_words', 'silent_start',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * The opening after the greeting (2026-11-14): when the greeting's words ended, when the caller first spoke, and when the
 * assistant's first reply to them began. "Why are you paused?" was a gap either before the caller spoke (turn
 * detection) or after (a backend round with nothing said): one log line, `opening timing`, tells which.
 */
export const OPENING_STEPS = ['greeting_end', 'first_caller', 'first_reply'] as const;
export type OpeningStep = (typeof OPENING_STEPS)[number];

export class CallMarks {
  private readonly at = new Map<SetupStep | OpeningStep, number>();
  /** The opening on the audio timeline (the transcript's own ms): the greeting's last word, the caller's first. */
  private greetingEndMs: number | null = null;
  private callerStartMs: number | null = null;
  /** When the caller's first turn last grew (wall clock), and whether the reply to it went through the backend. */
  private callerLastAt: number | null = null;
  private delegated = false;

  /** `t0` is when the call reached us: the webhook delivery, or the browser's request. */
  constructor(readonly t0 = Date.now()) {
    this.at.set('webhook', t0);
  }

  /** The first time a step is marked counts; a second mark (a sideband that reconnected) changes nothing. */
  mark(step: SetupStep | OpeningStep, at = Date.now()) {
    if (!this.at.has(step)) this.at.set(step, at);
  }

  has(step: SetupStep | OpeningStep) {
    return this.at.has(step);
  }

  /** The assistant's words before the caller has said anything: the greeting, whose end is the latest of them. */
  greetingWords(endMs: number, at = Date.now()) {
    if (this.at.has('first_caller')) return;
    this.greetingEndMs = endMs;
    this.at.set('greeting_end', at);
  }

  /** The caller's words before the first reply: the first marks when they started; each one moves their end. */
  callerWords(startMs: number, at = Date.now()) {
    if (this.at.has('first_reply')) return;
    if (!this.at.has('first_caller')) { this.callerStartMs = startMs; this.at.set('first_caller', at); }
    this.callerLastAt = at;
  }

  /** A hand-off to the backend before the first reply: the reply was the backend's. */
  delegation() {
    if (this.at.has('first_caller') && !this.at.has('first_reply')) this.delegated = true;
  }

  /**
   * The assistant starts its first reply to the caller: the opening line, once. Null before the caller has spoken, or
   * after the line was given.
   */
  replyStarted(at = Date.now()): Record<string, number | boolean | null> | null {
    if (!this.at.has('first_caller') || this.at.has('first_reply')) return null;
    this.at.set('first_reply', at);
    return {
      greeting_end_to_caller_ms: this.greetingEndMs === null || this.callerStartMs === null ? null : this.callerStartMs - this.greetingEndMs,
      caller_end_to_reply_ms: this.callerLastAt === null ? null : at - this.callerLastAt,
      reply_was_delegated: this.delegated,
      greeting_end_ms: this.ms('greeting_end'), first_caller_ms: this.ms('first_caller'), first_reply_ms: this.ms('first_reply'),
    };
  }

  /** Milliseconds from the webhook to the step; null when it never happened. */
  ms(step: SetupStep | OpeningStep): number | null {
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
