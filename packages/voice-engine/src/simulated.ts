// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from '@attendra/core';
import { randomUUID } from 'node:crypto';
import type { Sideband, SidebandCommand, SidebandEvent, VoiceEngine } from './engine';

/** One line of a simulated conversation. After a delegation the simulated voice says the backend's answer, or `reply` when given. */
export type SimulatedTurn =
  | { caller: string; delegate?: boolean; reply?: string }
  | { assistant: string };

export interface SimulatedScript {
  turns: SimulatedTurn[];
  /** Milliseconds between one line and the next. */
  pace?: number;
  /** The call hangs up on its own after this long, if nobody ends it. */
  maxSeconds?: number;
}

interface Session {
  id: string;
  script: SimulatedScript;
  handlers: ((e: SidebandEvent) => void)[];
  closeHandlers: ((code: number) => void)[];
  waiting: Map<string, (content: string) => void>;
  clock: number;
  closed: boolean;
  socketClosed: boolean;
  startedAt: number;
  /** Everything the backend sent, for tests: instructions, commentary. */
  sent: SidebandCommand[];
  timers: Set<NodeJS.Timeout>;
}

/**
 * A voice engine with no voice: it plays a scripted conversation into the real call
 * runner and agent, as sideband events, and answers what the backend sends. The demo
 * uses it to show a live call on the dashboard, and the e2e suite to watch, coach and
 * end one, without a microphone or an OpenAI key. It never makes a network call.
 */
export class SimulatedEngine implements VoiceEngine {
  readonly name = 'simulated';
  private readonly sessions = new Map<string, Session>();

  /** Creates a session to attach to, as a browser call would. */
  create(script: SimulatedScript, id = `sim_${randomUUID()}`): string {
    this.sessions.set(id, { id, script, handlers: [], closeHandlers: [], waiting: new Map(), clock: 0, closed: false, socketClosed: false, startedAt: Date.now(), sent: [], timers: new Set() });
    return id;
  }

  /** Starts the script once the runner is listening. */
  play(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('no such simulated session');
    void this.run(s);
    const limit = setTimeout(() => this.close(s, 'max_duration'), (s.script.maxSeconds ?? 300) * 1000);
    s.timers.add(limit);
  }

  /** What the backend sent to a session, for tests. */
  sentTo(sessionId: string): SidebandCommand[] {
    return this.sessions.get(sessionId)?.sent ?? [];
  }

  async accept(): Promise<void> {}
  async reject(): Promise<void> {}
  async startBrowserCall(_clinic: ClinicConfig): Promise<{ sessionId: string; sdpAnswer: string }> {
    throw new Error('the simulated engine has no audio; start a simulated call instead');
  }

  attach(sessionId: string): Sideband {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('no such simulated session');
    return {
      send: (cmd) => {
        s.sent.push(cmd);
        const c = cmd as { type: string; delegation_id?: string | null; content?: string };
        if (c.type === 'session.commentary.append' && c.delegation_id) s.waiting.get(c.delegation_id)?.(c.content ?? '');
        // the simulated voice says what an instruction asks it to say out loud: a quoted line, or a goodbye
        if (c.type === 'session.instructions.append' && c.content) {
          const quoted = c.content.match(/Say exactly: "([^"]+)"/)?.[1];
          if (quoted) void this.say(s, 'agent', quoted);
          else if (/say goodbye/i.test(c.content)) void this.say(s, 'agent', 'Thank you for calling. Take care, goodbye.');
        }
      },
      onEvent: (h) => { s.handlers.push(h); },
      onError: () => {},
      onClose: (h) => { s.closeHandlers.push(h); },
      // the backend closes its end once the call record is written, as with a real sideband
      close: () => {
        if (s.socketClosed) return;
        s.socketClosed = true;
        this.close(s, 'closed_by_backend', false);
        for (const h of s.closeHandlers) h(1000);
      },
    };
  }

  async transfer(sessionId: string, _targetUri?: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) this.close(s, 'transferred');
  }

  async hangup(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) this.close(s, 'agent_hangup');
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private emit(s: Session, e: Omit<SidebandEvent, 'event_id'> & Record<string, unknown>) {
    if (s.closed) return;
    const event = { event_id: `evt_${randomUUID()}`, ...e } as SidebandEvent;
    for (const h of s.handlers) h(event);
  }

  /** A line said in two or three fragments, as a transcriber sends them. */
  private async say(s: Session, speaker: 'caller' | 'agent', text: string) {
    const words = text.split(' ');
    const size = Math.max(3, Math.ceil(words.length / 3));
    for (let i = 0; i < words.length; i += size) {
      if (s.closed) return;
      const delta = (i ? ' ' : '') + words.slice(i, i + size).join(' ');
      const start = s.clock;
      s.clock += 400;
      this.emit(s, { type: speaker === 'caller' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', delta, start_ms: start, end_ms: s.clock });
      await this.wait(s, 250);
    }
    s.clock += 300;
  }

  private wait(s: Session, ms: number) {
    return new Promise<void>((resolve) => { const t = setTimeout(() => { s.timers.delete(t); resolve(); }, ms); s.timers.add(t); });
  }

  private async run(s: Session) {
    const pace = s.script.pace ?? 1200;
    for (const turn of s.script.turns) {
      if (s.closed) return;
      if ('assistant' in turn) { await this.say(s, 'agent', turn.assistant); await this.wait(s, pace); continue; }
      await this.say(s, 'caller', turn.caller);
      let answer = '';
      if (turn.delegate) {
        const id = `del_${randomUUID()}`;
        // the backend answers with commentary for this delegation; give it a few seconds
        const answered = new Promise<string>((resolve) => { s.waiting.set(id, resolve); const t = setTimeout(() => resolve(''), 8000); s.timers.add(t); });
        this.emit(s, { type: 'session.delegation.created', delegation: { id, target: 'client' } });
        answer = await answered;
        s.waiting.delete(id);
      }
      await this.wait(s, 400);
      // like the voice model, it says the backend's answer, unless the script gives its own words
      const spoken = turn.reply ?? answer;
      if (spoken) await this.say(s, 'agent', spoken);
      await this.wait(s, pace);
    }
    // then the line stays open, as a caller waiting, until someone ends it or the limit is reached
  }

  /** The conversation is over: session.closed, as the real engine sends it. The runner then writes the call and closes the socket. */
  private close(s: Session, reason: string, announce = true) {
    if (s.closed) return;
    if (announce) this.emit(s, { type: 'session.closed', reason, usage: { seconds: Math.round((Date.now() - s.startedAt) / 1000) } });
    s.closed = true;
    for (const t of s.timers) clearTimeout(t);
    s.timers.clear();
  }
}
