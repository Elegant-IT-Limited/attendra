// SPDX-License-Identifier: AGPL-3.0-only
import type { CallAgent, Outbound } from '@attendra/agent';
import type { Logger } from '@attendra/observability';
import { randomUUID } from 'node:crypto';
import type { Sideband, SidebandEvent, VoiceEngine } from './engine';

export interface CallRecorder {
  appendSegment(s: { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }): Promise<void>;
  close(c: { reason: string; voiceSeconds: number | null; outcome: string; emergency: boolean }): Promise<void>;
}

/**
 * Drives one call: reads sideband events, feeds the agent, and carries out what it
 * returns. It is the single owner of every side effect for its session, so events
 * seen twice (sideband replay after a reconnect) are dropped by event id.
 */
export class CallRunner {
  private readonly seen = new Set<string>();
  private flushedTurns = 0;
  private closed = false;
  private readonly timers = new Set<NodeJS.Timeout>();

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

    switch (event.type) {
      case 'session.input_transcript.delta': {
        const e = event as Extract<SidebandEvent, { delta: string }>;
        await this.dispatch(this.agent.onCallerTranscript(e.delta, e.start_ms, e.end_ms));
        return this.flushFinishedTurns();
      }
      case 'session.output_transcript.delta': {
        const e = event as Extract<SidebandEvent, { delta: string }>;
        this.agent.onAgentTranscript(e.delta, e.start_ms, e.end_ms);
        return this.flushFinishedTurns();
      }
      case 'session.delegation.created': {
        const e = event as Extract<SidebandEvent, { delegation: unknown }>;
        if (e.delegation.target !== 'client') return;
        // the progress note goes out immediately; the result follows when the tools finish
        return this.dispatch(await this.agent.onDelegation(e.delegation.id, (o) => void this.dispatch([o])));
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
        const act = () => (o.type === 'transfer' ? this.engine.transfer(this.sessionId, o.uri) : this.engine.hangup(this.sessionId))
          .catch((err) => {
            this.log.error({ session_id: this.sessionId, err }, `${o.type} failed`);
            // the caller is still there: tell staff, and have the assistant offer a callback
            if (!this.closed) return this.dispatch(this.agent.onControlFailed(o.type));
          });
        if (!o.afterMs) { await act(); continue; }
        const t = setTimeout(() => { this.timers.delete(t); void act(); }, o.afterMs);
        this.timers.add(t);
      } else if (o.type === 'instructions') {
        this.sideband.send({ type: 'session.instructions.append', event_id: `evt_${randomUUID()}`, delegation_id: null, content: o.content });
      } else {
        this.sideband.send({ type: `session.${o.type}.append`, event_id: `evt_${randomUUID()}`, delegation_id: o.delegationId, content: o.content });
      }
    }
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
    await this.flushFinishedTurns(true);
    const state = this.agent.state;
    // a hang-up staff asked for is recorded as theirs; a dropped line is still a dropped line
    if (state.endedByStaff && !note && reason !== 'connection_lost') reason = 'ended_by_staff';
    await this.recorder.close({ reason: note ?? reason, voiceSeconds, outcome: state.outcome, emergency: !!state.emergency });
    this.log.info({ session_id: this.sessionId, reason, outcome: state.outcome, voice_seconds: voiceSeconds }, 'call finished');
    this.sideband.close();
  }
}
