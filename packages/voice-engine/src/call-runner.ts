// SPDX-License-Identifier: AGPL-3.0-only
import type { CallAgent, Outbound } from '@attendra/agent';
import { saidGoodbye } from '@attendra/core';
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
/** The caller finished and nothing came back: a word to the assistant after this long, and again after the second. */
export const SILENCE_NUDGE_MS = [6000, 14_000] as const;
/** After the assistant's goodbye, how long the line may stay quiet before the call is ended for it. */
export const GOODBYE_HANGUP_MS = 6000;
/** An assistant turn that ends the call in words: "Goodbye.", "Have a great day!", "Adiós." */
const GOODBYE = /\b(good ?bye|bye(-bye| now)?|have a (good|great|nice|lovely|wonderful) (day|evening|night|weekend|afternoon|morning)|take care|adi[oó]s|hasta (luego|pronto)|que tenga (un )?(buen|feliz|lindo) (d[ií]a|tarde|noche|fin de semana)|cu[ií]dese)\W*$/i;

export class CallRunner {
  private readonly seen = new Set<string>();
  private flushedTurns = 0;
  private closed = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  /** When the assistant last said something: a hang-up waits until it has finished. */
  private agentSpokeAt = 0;
  /** When the caller last said something, and how many nudges that turn has had. */
  private callerSaidAt = 0;
  private nudged = 0;
  /** Delegations still running: the agent says "still checking" for those itself. */
  private pending = 0;
  /** A transfer or a hang-up is on its way: the assistant is meant to be quiet. */
  private ending = false;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly engine: VoiceEngine,
    private readonly sideband: Sideband,
    private readonly agent: CallAgent,
    private readonly recorder: CallRecorder,
    private readonly log: Logger,
  ) {}

  start(): Promise<void> {
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
        const later = (ms: number) => {
          const t = setTimeout(() => {
            this.timers.delete(t);
            const talking = Date.now() - this.agentSpokeAt < QUIET_MS;
            if ((o.type === 'hangup' || (o.type === 'transfer' && o.quiet)) && talking && Date.now() < due) later(500); else void act();
          }, ms);
          this.timers.add(t);
        };
        later(o.afterMs);
      } else if (o.type === 'instructions') {
        this.sideband.send({ type: 'session.instructions.append', event_id: `evt_${randomUUID()}`, delegation_id: null, content: o.content });
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
    const turns = this.agent.state.turns;
    const last = turns.at(-1);
    // the assistant said goodbye, nobody has spoken since, and the call was allowed to end:
    // the same two steps end_call needs ("anything else?", then the caller's no or goodbye)
    if (last?.speaker === 'agent' && GOODBYE.test(last.text.trim()) && this.agentSpokeAt >= this.callerSaidAt && now - this.agentSpokeAt >= GOODBYE_HANGUP_MS && !this.pending && this.mayEnd()) {
      this.log.info({ session_id: this.sessionId }, 'ending the call after the assistant\'s goodbye');
      return this.dispatch([{ type: 'hangup' }]);
    }
    // the caller spoke last, the assistant has said nothing since, and no tool is at work
    if (this.callerSaidAt > this.agentSpokeAt && !this.pending && this.nudged < SILENCE_NUDGE_MS.length && now - this.callerSaidAt >= SILENCE_NUDGE_MS[this.nudged]!) {
      this.nudged++;
      this.log.info({ session_id: this.sessionId, nudge: this.nudged }, 'the caller is waiting in silence: nudging the assistant');
      return this.dispatch(this.agent.onSilence(this.nudged));
    }
  }

  /** The caller's last turn answered "anything else?" with a no or a goodbye. */
  private mayEnd() {
    const turns = this.agent.state.turns;
    let i = turns.length - 1;
    while (i >= 0 && turns[i]!.speaker !== 'caller') i--;
    if (i < 0) return false;
    const asked = turns.slice(0, i).filter((t) => t.speaker === 'agent').slice(-2).map((t) => t.text).join(' ');
    return saidGoodbye(turns[i]!.text, asked);
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
