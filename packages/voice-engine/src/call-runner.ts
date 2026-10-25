// SPDX-License-Identifier: AGPL-3.0-only
import type { CallAgent, Outbound } from '@attendra/agent';
import { askedToHangUp, saidGoodbye } from '@attendra/core';
import type { Logger } from '@attendra/observability';
import { randomUUID } from 'node:crypto';
import type { Sideband, SidebandEvent, VoiceEngine } from './engine';

export interface CallRecorder {
  appendSegment(s: { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }): Promise<void>;
  close(c: { reason: string; voiceSeconds: number | null; outcome: string; emergency: boolean; language?: string }): Promise<void>;
}

/**
 * Drives one call: reads sideband events, feeds the agent, and carries out what it
 * returns. It is the single owner of every side effect for its session, so events
 * seen twice (sideband replay after a reconnect) are dropped by event id.
 */
/** How long the assistant must be quiet before a hang-up goes through, and the most it waits for that. */
const QUIET_MS = 1500;
const HANGUP_MAX_WAIT_MS = 20_000;
/**
 * After its delay, how long an action may wait on audio still playing (not on new words):
 * a goodbye is one short sentence; an emergency script before the on-call transfer can be
 * long, and is waited for up to the overall limit.
 */
const SPEECH_WAIT_MS = { hangup: 4000, transfer: HANGUP_MAX_WAIT_MS } as const;
/** The caller finished and nothing came back: a word to the assistant after this long, and again after the second. */
export const SILENCE_NUDGE_MS = [6000, 14_000] as const;
/**
 * The call is up and the assistant has said nothing, nor has the caller: after this long it
 * is told once to greet now. GPT-Live sometimes held its greeting until the caller spoke,
 * 15 seconds into a call (2026-10-25).
 */
export const OPENING_NUDGE_MS = 4000;
const OPENING_NUDGE = 'The call is connected and the caller has not heard you yet. Greet them now, exactly as you were told to at the start of the call, then listen.';
/** After the assistant's goodbye, how long the line may stay quiet before the call is ended for it. */
export const GOODBYE_HANGUP_MS = 6000;
/** After the caller asked for the call to end ("can you cut the call?"), how long it may stay up for the assistant's goodbye. */
export const ASKED_HANGUP_MS = 2500;
/**
 * The words of a reply arrive well before its audio has played, so "quiet" is counted
 * from when the voice should have finished: about this long per character, on the slow
 * side, so a long answer is never mistaken for silence.
 */
export const SPOKEN_MS_PER_CHAR = 80;
/** An assistant turn that ends the call in words: "Goodbye.", "Have a great day!", "Adiós." */
const GOODBYE = /\b(good ?bye|bye(-bye| now)?|have a (good|great|nice|lovely|wonderful) (day|evening|night|weekend|afternoon|morning)|take care|talk (to you )?soon|speak (to you )?soon|see you( soon| then| later)?|adi[oó]s|hasta (luego|pronto)|que tenga (un )?(buen|feliz|lindo) (d[ií]a|tarde|noche|fin de semana)|cu[ií]dese)\W*$/i;

export class CallRunner {
  private readonly seen = new Set<string>();
  private flushedTurns = 0;
  private closed = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  /** When the assistant last said something: a hang-up waits until it has finished. */
  private agentSpokeAt = 0;
  /** When the assistant's voice should have finished what it has said so far. */
  private speakingUntil = 0;
  /** When the caller last said something, and how many nudges that turn has had. */
  private callerSaidAt = 0;
  private nudged = 0;
  /** Delegations still running: the agent says "still checking" for those itself. */
  private pending = 0;
  /** A transfer or a hang-up is on its way: the assistant is meant to be quiet. */
  private ending = false;
  private watchdog: NodeJS.Timeout | null = null;
  /** When the runner started, and whether the silent-start nudge went out. */
  private startedAt = 0;
  private openingNudged = false;

  constructor(
    private readonly sessionId: string,
    private readonly engine: VoiceEngine,
    private readonly sideband: Sideband,
    private readonly agent: CallAgent,
    private readonly recorder: CallRecorder,
    private readonly log: Logger,
  ) {}

  start(): Promise<void> {
    this.startedAt = Date.now();
    // checks from the first second, not from the first event: a silent start has no events
    this.watch();
    return new Promise((resolve) => {
      this.sideband.onEvent((event) => { void this.handle(event).catch((err) => this.log.error({ session_id: this.sessionId, err }, 'event handling failed')); });
      this.sideband.onError((err) => this.log.warn({ session_id: this.sessionId, err }, 'sideband error'));
      this.sideband.onClose((code) => {
        // a socket that drops before session.closed leaves the call without final usage
        // resolve even when the final write fails, or the call never counts as over
        if (!this.closed) {
          void this.finish('connection_lost', null, `socket closed ${code} before session.closed`)
            .catch((err) => this.log.error({ session_id: this.sessionId, err }, 'closing the call record failed'))
            .finally(resolve);
        }
        else resolve();
      });
    });
  }

  async handle(event: SidebandEvent): Promise<void> {
    if (this.seen.has(event.event_id)) return;
    this.seen.add(event.event_id);
    this.watch();

    switch (event.type) {
      case 'session.input_transcript.delta': {
        const e = event as Extract<SidebandEvent, { delta: string }>;
        this.callerSaidAt = Date.now();
        this.nudged = 0;
        await this.dispatch(this.agent.onCallerTranscript(e.delta, e.start_ms, e.end_ms));
        return this.flushFinishedTurns();
      }
      case 'session.output_transcript.delta': {
        const e = event as Extract<SidebandEvent, { delta: string }>;
        this.agent.onAgentTranscript(e.delta, e.start_ms, e.end_ms);
        this.agentSpokeAt = Date.now();
        this.speakingUntil = Math.max(this.speakingUntil, this.agentSpokeAt) + e.delta.length * SPOKEN_MS_PER_CHAR;
        return this.flushFinishedTurns();
      }
      case 'session.delegation.created': {
        const e = event as Extract<SidebandEvent, { delegation: unknown }>;
        if (e.delegation.target !== 'client') return;
        // the progress note goes out immediately; the result follows when the tools finish
        this.pending++;
        try {
          return await this.dispatch(await this.agent.onDelegation(e.delegation.id, (o) => void this.dispatch([o])));
        } finally {
          this.pending--;
        }
      }
      case 'session.instructions.appended': {
        // a staff note reached the voice model
        const e = event as SidebandEvent & { client_event_id?: string };
        if (e.client_event_id?.startsWith('coach_')) this.agent.onCoachDelivered();
        return;
      }
      case 'session.closed': {
        const e = event as Extract<SidebandEvent, { reason: string }>;
        return this.finish(e.reason, e.usage?.seconds ?? null);
      }
      case 'error': {
        const e = event as Extract<SidebandEvent, { error?: unknown }>;
        this.log.warn({ session_id: this.sessionId, code: e.error?.code }, 'sideband error event');
        return;
      }
      default:
        return;
    }
  }

  /** Carries out what staff asked for on a live call (a note, a take-over, a goodbye) the same way as the agent's own outbound. */
  act(outbound: Outbound[]): Promise<void> {
    return this.dispatch(outbound);
  }

  private async dispatch(outbound: Outbound[]) {
    for (const o of outbound) {
      if (o.type === 'transfer' || o.type === 'hangup') {
        // one call-control action at a time: a second transfer or hang-up while one is on its
        // way would race it (and fail, and tell staff it failed)
        if (this.ending) { this.log.info({ session_id: this.sessionId, action: o.type }, 'a transfer or hang-up is already on its way; this one is dropped'); continue; }
        this.ending = true;
        const act = () => (o.type === 'transfer' ? this.engine.transfer(this.sessionId, o.uri) : this.engine.hangup(this.sessionId))
          .catch((err) => {
            this.log.error({ session_id: this.sessionId, err }, `${o.type} failed`);
            // the caller is still there: tell staff, and have the assistant offer a callback
            this.ending = false;
            if (!this.closed) return this.dispatch(this.agent.onControlFailed(o.type));
          });
        if (!o.afterMs) { await act(); continue; }
        // a goodbye is never cut off: the hang-up waits until the assistant has gone quiet
        const due = Date.now() + HANGUP_MAX_WAIT_MS;
        // the estimate of audio still playing is trusted for a while only: a model that
        // keeps talking after its goodbye is not waited for to the end
        const heard = Date.now() + o.afterMs + SPEECH_WAIT_MS[o.type];
        const later = (ms: number) => {
          const t = setTimeout(() => {
            this.timers.delete(t);
            // still talking: words came in a moment ago, or their audio has not finished playing
            const talking = Date.now() - this.agentSpokeAt < QUIET_MS || (Date.now() < this.speakingUntil && Date.now() < heard);
            if ((o.type === 'hangup' || (o.type === 'transfer' && o.quiet)) && talking && Date.now() < due) later(500); else void act();
          }, ms);
          this.timers.add(t);
        };
        later(o.afterMs);
      } else if (o.type === 'instructions') {
        this.sideband.send({ type: 'session.instructions.append', event_id: o.eventId ?? `evt_${randomUUID()}`, delegation_id: null, content: o.content });
      } else {
        this.sideband.send({ type: `session.${o.type}.append`, event_id: `evt_${randomUUID()}`, delegation_id: o.delegationId, content: o.content });
      }
    }
  }

  /**
   * Once a second, two checks no model can be trusted to make on its own:
   * - the caller finished speaking and nothing came back (no answer, no tool at work):
   *   the assistant is told to answer now, at 6 s and again at 14 s;
   * - the assistant said goodbye and the line has been quiet since: the call is ended.
   * Neither runs while a transfer or a hang-up is on its way, or after the call ends.
   */
  private watch() {
    if (this.watchdog || this.closed) return;
    this.watchdog = setInterval(() => { void this.check().catch((err) => this.log.warn({ session_id: this.sessionId, err }, 'call check failed')); }, 1000);
    this.watchdog.unref?.();
  }

  private async check() {
    if (this.closed || this.ending || this.agent.state.endedByStaff) return;
    const now = Date.now();
    // nobody has said a word since the call was answered: the greeting is overdue
    if (!this.openingNudged && this.startedAt && !this.agentSpokeAt && !this.callerSaidAt && now - this.startedAt >= OPENING_NUDGE_MS) {
      this.openingNudged = true;
      this.log.info({ session_id: this.sessionId }, 'the assistant has not greeted the caller: nudging it');
      return this.dispatch([{ type: 'instructions', delegationId: null, content: OPENING_NUDGE }]);
    }
    const turns = this.agent.state.turns;
    const last = turns.at(-1);
    // the assistant said goodbye, nobody has spoken since, and the call was allowed to end:
    // the same two steps end_call needs ("anything else?", then the caller's no or goodbye)
    if (last?.speaker === 'agent' && GOODBYE.test(last.text.trim()) && this.agentSpokeAt >= this.callerSaidAt && now - this.speakingUntil >= GOODBYE_HANGUP_MS && !this.pending && this.mayEnd()) {
      this.log.info({ session_id: this.sessionId }, 'ending the call after the assistant\'s goodbye');
      return this.dispatch([{ type: 'hangup' }]);
    }
    // the caller asked for the call to end ("cut the call", "hang up"), or answered the assistant's goodbye with
    // their own ("Take care." "Take care, bye"): it ends. Anything still being looked up is dropped, never waited
    // for: a goodbye sent to the backend as a question kept a caller on the line for a minute (2026-10-24)
    const callerLast = [...turns].reverse().find((t) => t.speaker === 'caller');
    const agentLast = [...turns].reverse().find((t) => t.speaker === 'agent');
    const byeAfterBye = last?.speaker === 'caller' && !!agentLast && GOODBYE.test(agentLast.text.trim()) && saidGoodbye(last.text, agentLast.text);
    if (callerLast && (askedToHangUp(callerLast.text) || byeAfterBye) && now - this.callerSaidAt >= ASKED_HANGUP_MS && this.agent.canEndByStaff()) {
      this.log.info({ session_id: this.sessionId, pending: this.pending }, byeAfterBye ? 'ending the call: both sides said goodbye' : 'ending the call: the caller asked for it');
      this.agent.state.revision++;
      return this.dispatch([{ type: 'hangup', afterMs: 1 }]);
    }
    // a promise to call back that no request backs: the assistant is told to make it, once it has finished speaking
    if (now - this.agentSpokeAt >= QUIET_MS && now >= this.speakingUntil) {
      const leaked = this.agent.onLeakCheck();
      if (leaked.length) return this.dispatch(leaked);
      const promised = this.agent.onPromiseCheck();
      if (promised.length) return this.dispatch(promised);
    }
    // the caller spoke after the assistant's voice had finished, nothing has come back, and
    // no tool is at work. A caller's words that arrive while the reply is still playing
    // (transcription can lag the reply) are not a wait.
    // a caller whose last words were a goodbye is not waiting: a nudge there made the assistant start talking again (Scout, 2026-10-24)
    const leaving = last?.speaker === 'caller' && saidGoodbye(last.text, agentLast?.text ?? '');
    if (this.callerSaidAt > this.speakingUntil && !this.pending && !leaving && this.nudged < SILENCE_NUDGE_MS.length && now - this.callerSaidAt >= SILENCE_NUDGE_MS[this.nudged]!) {
      this.nudged++;
      this.log.info({ session_id: this.sessionId, nudge: this.nudged }, 'the caller is waiting in silence: nudging the assistant');
      return this.dispatch(this.agent.onSilence(this.nudged));
    }
  }

  /**
   * The caller's last words answered "anything else?" with a no or a goodbye. A goodbye
   * the assistant talked over arrives in pieces ("Bye. Have a" … "nice day"), so the
   * caller's last two turns are read together.
   */
  private mayEnd() {
    const turns = this.agent.state.turns;
    const callers: number[] = [];
    for (let i = turns.length - 1; i >= 0 && callers.length < 2; i--) if (turns[i]!.speaker === 'caller') callers.unshift(i);
    if (!callers.length) return false;
    const first = callers[0]!;
    const asked = turns.slice(0, first).filter((t) => t.speaker === 'agent').slice(-2).map((t) => t.text).join(' ');
    const said = callers.map((i) => turns[i]!.text).join(' ');
    return saidGoodbye(said, asked) || saidGoodbye(turns[callers.at(-1)!]!.text, turns.slice(0, callers.at(-1)!).filter((t) => t.speaker === 'agent').slice(-2).map((t) => t.text).join(' '));
  }

  /**
   * Stores every turn except the last one, which may still be growing. Events are
   * handled concurrently, so each turn index is claimed before the write is awaited:
   * no turn is stored twice or skipped.
   */
  private async flushFinishedTurns(all = false) {
    const turns = this.agent.state.turns;
    const upTo = all ? turns.length : turns.length - 1;
    while (this.flushedTurns < upTo) {
      const t = turns[this.flushedTurns++]!;
      await this.recorder.appendSegment({ speaker: t.speaker, text: t.text, startMs: t.startMs, endMs: t.endMs });
    }
  }

  private async finish(reason: string, voiceSeconds: number | null, note?: string) {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    if (this.watchdog) clearInterval(this.watchdog);
    await this.flushFinishedTurns(true);
    const state = this.agent.state;
    // a hang-up staff asked for is recorded as theirs; a dropped line is still a dropped line
    if (state.endedByStaff && !note && reason !== 'connection_lost') reason = 'ended_by_staff';
    await this.recorder.close({ reason: note ?? reason, voiceSeconds, outcome: state.outcome, emergency: !!state.emergency, language: state.language });
    this.log.info({ session_id: this.sessionId, reason, outcome: state.outcome, voice_seconds: voiceSeconds }, 'call finished');
    this.sideband.close();
  }
}
