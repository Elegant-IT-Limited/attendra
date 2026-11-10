// SPDX-License-Identifier: AGPL-3.0-only
import { type CallAgent, callStateNote, type Outbound } from '@attendra/agent';
import { addTokens, askedToHangUp, type CallQuality, EMPTY_CALL_MIN_MS, maxGapMs, type ModelTokens, recordedOutcome, repeatedQuestions, saidGoodbye } from '@attendra/core';
import { isOpenAiQuotaError, type Logger } from '@attendra/observability';
import { randomUUID } from 'node:crypto';
import type { Sideband, SidebandConnection, SidebandEvent, VoiceEngine } from './engine';
import { CallMarks } from './marks';
import { openingIfNotStarted } from './prompt';

export interface CallRecorder {
  appendSegment(s: { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }): Promise<void>;
  close(c: { reason: string; voiceSeconds: number | null; outcome: string; emergency: boolean; emergencyResult?: string | null; language?: string; quality?: CallQuality; usage?: { models: Record<string, ModelTokens>; fastTier?: boolean; engineUsd?: number } }): Promise<void>;
}

/**
 * Where the runner says something is wrong with a call the caller is on, for the people who
 * run Attendra (Slack): a caller left in silence, a line they heard nothing on. Codes and ids only.
 */
export interface CallAlerts {
  alert(kind: 'stalled_turn' | 'empty_call' | 'openai_quota', text: string): void;
}

/**
 * Drives one call: reads sideband events, feeds the agent, and carries out what it
 * returns. It is the single owner of every side effect for its session, so events
 * seen twice (sideband replay after a reconnect) are dropped by event id, except a
 * hand-off: each delegation id is requested once whatever its event id, and one
 * answered just before the sideband dropped is answered again once it is back.
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
/**
 * The caller finished and nothing came back (no reply, no hand-off to the backend): their words go back to the
 * assistant to answer after this long, and again after the second. 6 s left callers asking "are you with me?" (2026-10-26).
 */
export const SILENCE_NUDGE_MS = [5000, 12_000] as const;
/** How often the runner checks the line: often enough that a nudge comes within half a second of its time. */
const CHECK_MS = 500;
/**
 * The call is up and the assistant has said nothing, nor has the caller: after this long it
 * is told once more to greet now. The opening itself goes out the moment the session starts
 * (about 0.3 s in), as OpenAI's "greet the caller" sequence has it; this is the backstop for
 * a model that stayed silent all the same (2026-10-25, 2026-10-26, and 5 of 12 phone calls
 * on 2026-10-29). On its own timer, so it is not up to a second late.
 */
export const OPENING_NUDGE_MS = 2500;
/**
 * By then a caller who has heard nothing is never left waiting longer (batch 1e): four phone calls in October lasted
 * exactly 30 s with no assistant audio until the session expired. The call goes to the front desk when the clinic has
 * one, or ends, and the call is recorded as `no_audio` with the empty-call alert, so the team sees it at once.
 */
export const SILENT_START_DEADLINE_MS = 9000;
/** An answer sent this long before the sideband dropped may never have reached the voice. */
const LOST_BEFORE_DROP_MS = 3000;
const OPENING_NUDGE = 'The call is connected and the caller has not heard you yet. Only if you have not started speaking and the caller has said nothing: greet them now, exactly as you were told to at the start of the call, then listen. If any part of the greeting was said, or the caller has spoken, never start it again: answer them.';
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
  /** When the caller last stopped speaking, by the engine's turn detection: a wait is timed from here when it is known. */
  private callerStoppedAt = 0;
  /** The caller ended the call themselves (the dashboard's End, or the test-call page closed): the line closing next is theirs. */
  private callerEnding = false;
  private nudged = 0;
  /** Delegations still running: the agent says "still checking" for those itself. */
  private pending = 0;
  /** A transfer or a hang-up is on its way: the assistant is meant to be quiet. */
  /** A transfer or hang-up on its way (one at a time), by kind; null when none is. */
  private ending: 'transfer' | 'hangup' | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  /** When the runner started, and whether the silent-start nudge went out. */
  private startedAt = 0;
  private openingNudged = false;
  /**
   * When the assistant's audio first reached the line, from the copy the sideband gets of it: the surest sign a
   * greeting is under way. Its transcript comes later, and a nudge sent in between restarted the greeting ("Thanks
   * Thanks for calling", 2026-10-29).
   */
  private audioStartedAt = 0;
  /** The call's setup moments, for the one timing line; the server passes the ones it knows. */
  private readonly marks: CallMarks;
  private timed = false;
  /** Every hand-off by its id: requested once, and its answer kept in case a sideband drop lost it. */
  private readonly delegations = new Map<string, { answer: Outbound[]; sentAt: number | null }>();
  /** When the sideband last dropped, and how often it came back. */
  private droppedAt = 0;
  private reconnects = 0;
  /** Whether the assistant is speaking now, as far as its words show, for the logs. */
  private speaking = false;
  /**
   * When the caller could first have heard the assistant: its first audio, or its first words on an engine whose
   * sideband carries no audio (gpt-realtime). Zero until then; still zero at the end, the call is `no_audio`.
   */
  private heardAt = 0;
  /** Caller turns met by 5 s of silence with nothing coming back: the first nudge of a turn is one stall. */
  private stalls = 0;
  /**
   * The answer to a turn that needed a lookup, timed on the engine's session timeline: when the caller's last words
   * ended, how many tools (or hand-offs) ran for it, and whether a result has gone back to the voice. The first words
   * after a result are the answer (a "let me check" said before it is not).
   */
  private callerEndMs = 0;
  private turnTools = 0;
  private answerDue = false;
  /** Tool calls on the tools path, by call id: each is answered once, whatever a sideband replay sends again. */
  private readonly toolCalls = new Set<string>();
  /** The last call-state line the voice model was given (tools path). */
  private stateNote: string | null = null;
  /**
   * The tools path on an engine that can wait for our go (gpt-realtime): once a pet is found, after each caller turn the
   * lookup their words ask for is run and handed to the voice before it replies (round 2). Set by the voice service.
   */
  manualTurns = false;
  /**
   * How long a close the runner did not expect waits for the caller's own end to be told (a browser test call: the page
   * asks our API to end the call as it closes the line, and the two can arrive in either order). 0: decided at once.
   */
  closeGraceMs = 0;

  /** The caller ended the call from their side (the dashboard's End, a closed page): a close after this is a hang-up, not a drop. */
  callerEnded() {
    this.callerEnding = true;
  }
  private manual = false;
  /**
   * Where a call whose assistant never spoke goes at SILENT_START_DEADLINE_MS: the clinic's front desk, or null to end it
   * (no front desk, a browser test call). Set by the voice service; undefined leaves the call as it is.
   */
  silentStartUri: string | null | undefined = undefined;
  private silentStartHandled = false;

  constructor(
    private readonly sessionId: string,
    private readonly engine: VoiceEngine,
    private readonly sideband: Sideband,
    private readonly agent: CallAgent,
    private readonly recorder: CallRecorder,
    private readonly log: Logger,
    marks?: CallMarks,
    /**
     * Where trouble on this call is said. With `where` (the clinic and call, never the caller) the alert names the clinic
     * and links the call itself; without it the line names the session.
     */
    private readonly alerts?: CallAlerts & { where?: object },
  ) {
    this.marks = marks ?? new CallMarks();
    // start() sets it again; a runner driven without it still times from when it was made
    this.startedAt = Date.now();
  }

  /** The call as the caller heard it so far, for the call row and the daily digest. */
  quality(): CallQuality {
    return { firstAudioMs: this.heardAt ? this.heardAt - this.startedAt : null, stalls: this.stalls, answerTimeouts: this.agent.state.answerTimeouts };
  }

  start(): Promise<void> {
    this.startedAt = Date.now();
    this.marks.mark('runner_started', this.startedAt);
    // checks from the first second, not from the first event: a silent start has no events
    this.watch();
    const opening = setTimeout(() => { this.timers.delete(opening); void this.openingCheck().catch((err) => this.log.warn({ session_id: this.sessionId, err }, 'call check failed')); }, OPENING_NUDGE_MS);
    this.timers.add(opening);
    const deadline = setTimeout(() => { this.timers.delete(deadline); void this.silentStartCheck().catch((err) => this.log.warn({ session_id: this.sessionId, err }, 'call check failed')); }, SILENT_START_DEADLINE_MS);
    this.timers.add(deadline);
    return new Promise((resolve) => {
      this.sideband.onEvent((event) => { void this.handle(event).catch((err) => this.log.error({ session_id: this.sessionId, err }, 'event handling failed')); });
      this.sideband.onError((err) => this.log.warn({ session_id: this.sessionId, err }, 'sideband error'));
      this.sideband.onConnection?.((c) => this.connection(c));
      this.sideband.onClose((code) => {
        this.log.info({ session_id: this.sessionId, code, ms: Date.now() - this.startedAt }, 'sideband closed');
        // a socket that drops before session.closed leaves the call without final usage
        // resolve even when the final write fails, or the call never counts as over
        if (!this.closed) {
          // a call that was already ending normally is not a dropped line: the assistant's hang-up on its way, the
          // caller's goodbye before the line went (a test call said "Okay, bye" and was listed as "Connection dropped";
          // note 45, A6), or the caller ending it themselves (the dashboard's End, a closed page; 2026-11-11: a Realtime
          // call's socket closes with 1006 however it ends, so every test call ended by its caller was a "drop")
          const normal = () => (this.ending === 'hangup' ? 'agent_hangup' : this.callerEnding || this.mayEnd() ? 'caller_hangup' : null);
          const record = (reason: string | null) => void (reason ? this.finish(reason, null) : this.finish('connection_lost', null, `socket closed ${code} before session.closed`))
            .catch((err) => this.log.error({ session_id: this.sessionId, err }, 'closing the call record failed'))
            .finally(resolve);
          if (normal() || !this.closeGraceMs) record(normal());
          else setTimeout(() => record(normal()), this.closeGraceMs);
        }
        else resolve();
      });
    });
  }

  async handle(event: SidebandEvent): Promise<void> {
    // the assistant's audio, many events a second: only the first matters (it is speaking), and none is remembered
    if (event.type === 'session.output_audio.delta') {
      if (!this.audioStartedAt) {
        this.audioStartedAt = Date.now();
        if (!this.heardAt) this.heardAt = this.audioStartedAt;
        this.marks.mark('first_audio', this.audioStartedAt);
        this.log.info({ session_id: this.sessionId, ms: this.audioStartedAt - this.startedAt, opening_nudged: this.openingNudged }, 'first audio from the assistant');
      }
      return;
    }
    // a hand-off is known by its delegation id, not its event id: see below
    if (event.type !== 'session.delegation.created') {
      if (this.seen.has(event.event_id)) return;
      this.seen.add(event.event_id);
    }
    this.watch();

    switch (event.type) {
      case 'session.input_speech.stopped': {
        this.callerStoppedAt = Date.now();
        return;
      }
      case 'session.input_transcript.delta': {
        const e = event as Extract<SidebandEvent, { start_ms: number }>;
        // when the caller stopped speaking, not when their words were written down: the transcript can arrive after the
        // answer, and a wait timed from it nudged the assistant to talk over a reply already given (2026-11-11)
        const now = Date.now();
        this.callerSaidAt = this.callerStoppedAt > this.callerSaidAt && this.callerStoppedAt <= now ? this.callerStoppedAt : now;
        this.marks.callerWords(e.start_ms, this.callerSaidAt);
        this.nudged = 0;
        // a new caller turn: a lookup it needs is timed from the end of these words
        this.callerEndMs = e.end_ms;
        this.turnTools = 0;
        this.answerDue = false;
        const heard = this.agent.onCallerTranscript(e.delta, e.start_ms, e.end_ms);
        await this.dispatch(heard);
        // replies are ours to start: the lookup their words ask for first, then the go. An instruction from the words
        // themselves (an emergency script, an abuse warning) starts its own reply
        if (this.manual && !heard.some((o) => o.type === 'instructions')) await this.replyAfterWords();
        return this.flushFinishedTurns();
      }
      case 'session.output_transcript.delta': {
        const e = event as Extract<SidebandEvent, { start_ms: number }>;
        // a result said with no tool behind it is corrected at once (the claim guard, batch 1b)
        const corrections = this.agent.onAgentTranscript(e.delta, e.start_ms, e.end_ms);
        if (corrections.length) void this.dispatch(corrections);
        // the first words after a lookup's result: how long the caller waited for the answer
        if (this.answerDue) {
          this.answerDue = false;
          this.agent.recordAnswerTiming({ waitMs: e.start_ms - this.callerEndMs, tools: this.turnTools, flow: this.toolCalls.size ? 'tools' : 'planner' });
        }
        const now = Date.now();
        this.marks.greetingWords(e.end_ms, now);
        // the start of a reply, for the logs (no words): the first one is the greeting, timed from the start of the call
        if (!this.speaking) {
          this.speaking = true;
          if (!this.agentSpokeAt) {
            if (!this.heardAt) this.heardAt = now;
            this.marks.mark('first_words', now);
            this.log.info({ session_id: this.sessionId, ms: now - this.startedAt, opening_nudged: this.openingNudged }, 'first words from the assistant');
            this.timing();
          }
          else {
            this.log.info({ session_id: this.sessionId, after_caller_ms: this.callerSaidAt > this.agentSpokeAt ? now - this.callerSaidAt : null }, 'assistant started speaking');
            // the first reply to the caller: how long the gap was before they spoke, and after
            const opening = this.marks.replyStarted(now);
            if (opening) this.log.info({ session_id: this.sessionId, ...opening }, 'opening timing');
          }
        }
        this.agentSpokeAt = now;
        this.speakingUntil = Math.max(this.speakingUntil, this.agentSpokeAt) + e.delta.length * SPOKEN_MS_PER_CHAR;
        return this.flushFinishedTurns();
      }
      case 'session.delegation.created': {
        const e = event as Extract<SidebandEvent, { delegation: unknown }>;
        if (e.delegation.target !== 'client') return;
        const id = e.delegation.id;
        const known = this.delegations.get(id);
        if (known) {
          // the same hand-off again (a sideband that reconnected sends what it still has): answered before a drop and
          // never spoken, it is answered again; still being worked on, its answer is on its way
          if (known.sentAt !== null && this.reconnects && this.agentSpokeAt < known.sentAt) {
            this.log.info({ session_id: this.sessionId, delegation_id: id }, 'delegation seen again after a reconnect: answering it again');
            return this.resend(id);
          }
          this.log.info({ session_id: this.sessionId, delegation_id: id, answered: known.sentAt !== null }, 'delegation seen again: already handled');
          return;
        }
        this.log.info({ session_id: this.sessionId, delegation_id: id, at: new Date().toISOString(), ms: Date.now() - this.startedAt }, 'delegation created');
        this.marks.delegation();
        this.turnTools++;
        const entry: { answer: Outbound[]; sentAt: number | null } = { answer: [], sentAt: null };
        this.delegations.set(id, entry);
        // the progress note goes out immediately; the result follows when the tools finish
        this.pending++;
        try {
          const out = await this.agent.onDelegation(id, (o) => void this.dispatch([o]));
          entry.answer = out.filter((o) => o.type === 'commentary');
          entry.sentAt = Date.now();
          if (entry.answer.length) this.answerDue = true;
          return await this.dispatch(out);
        } finally {
          this.pending--;
        }
      }
      case 'session.tool_call': {
        // the tools path: the voice (or GPT-Live's delegated model) called one of our tools itself
        const e = event as Extract<SidebandEvent, { call_id: string; name: string; arguments: string }>;
        const output = await this.callTool(e.call_id, e.name, e.arguments);
        if (output === null || this.closed) return;
        // the call's state, when this tool changed it, goes in before the result the model answers from (batch 1d)
        const state = callStateNote(this.agent.state);
        if (state && state !== this.stateNote) { this.stateNote = state; this.sideband.send({ type: 'context.note', event_id: `state_${e.call_id}`, content: state }); }
        this.sideband.send({ type: 'tool.result', event_id: `tool_${e.call_id}`, call_id: e.call_id, output });
        return;
      }
      case 'session.model_usage': {
        const e = event as Extract<SidebandEvent, { model: string; input: number }>;
        addTokens(this.agent.state.modelTokens, e.model, { input: e.input, cached: e.cached, output: e.output });
        return;
      }
      case 'session.started': {
        this.marks.mark('session_started');
        this.log.info({ session_id: this.sessionId, ms: Date.now() - this.startedAt }, 'session started');
        // OpenAI's "greet the caller" sequence: the greeting once more, as a commentary (something to say now), right
        // after session.started with the caller's audio running. The developer message at the start alone does not
        // make the model speak. By now a greeting may be under way, or the caller may have spoken: never from the top
        const opening = this.marks.has('opening_sent') ? null : this.engine.opening?.(this.sessionId);
        if (opening && !this.closed) {
          this.marks.mark('opening_sent');
          this.log.info({ session_id: this.sessionId, ms: Date.now() - this.startedAt }, 'opening sent');
          this.sideband.send({ type: 'session.commentary.append', event_id: `opening_${this.sessionId}`, delegation_id: null, content: openingIfNotStarted(opening) });
        }
        return;
      }
      // the phone leg itself: answered, or failed to connect. A failed leg is a call the caller never heard: it ends now,
      // with the carrier's code as its reason, instead of a session left to expire in silence
      case 'transport.answered': {
        this.marks.mark('transport_answered');
        this.log.info({ session_id: this.sessionId, ms: Date.now() - this.startedAt }, 'phone leg answered');
        return;
      }
      case 'transport.failed': {
        const code = (event as { error?: { code?: string } }).error?.code ?? 'unknown';
        this.log.warn({ session_id: this.sessionId, code, ms: Date.now() - this.startedAt }, 'phone leg failed to connect');
        return this.finish('transport_failed', null, `transport failed: ${code}`);
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
        // OpenAI out of credit stops every call: it pages at once
        if (isOpenAiQuotaError(e.error)) this.alerts?.alert('openai_quota', 'OpenAI refused a request on a live call: the credit or quota is used up. Calls fail until it is topped up.');
        return;
      }
      default:
        return;
    }
  }

  /**
   * The sideband's connection, logged. When it comes back after a drop, an answer sent just before the drop (or while
   * it was down) that the assistant has not spoken since is sent again: the caller would otherwise wait for it forever.
   */
  private connection(c: SidebandConnection) {
    if (c.state === 'open') this.marks.mark('sideband_open');
    this.log.info({ session_id: this.sessionId, ...c, ms: Date.now() - this.startedAt }, `sideband ${c.state}`);
    if (c.state === 'reconnecting' && !this.droppedAt) this.droppedAt = Date.now();
    if (c.state !== 'reconnected') return;
    this.reconnects++;
    const since = this.droppedAt - LOST_BEFORE_DROP_MS;
    this.droppedAt = 0;
    for (const [id, d] of this.delegations) {
      if (d.sentAt !== null && d.sentAt >= since && this.agentSpokeAt < d.sentAt) void this.resend(id).catch((err) => this.log.warn({ session_id: this.sessionId, err }, 'answer not sent again'));
    }
  }

  private resend(id: string) {
    const d = this.delegations.get(id);
    if (!d?.answer.length || this.closed) return Promise.resolve();
    d.sentAt = Date.now();
    this.log.info({ session_id: this.sessionId, delegation_id: id }, 'answer sent again after the sideband came back');
    return this.dispatch(d.answer);
  }

  /**
   * One tool call on the tools path, by its id (each runs once, whatever a replay sends again), from an engine's event
   * or from the tools API's HTTP surface: the agent runs it, any call control it returns is carried out, and the next
   * words the voice says are timed as the answer. Returns the result as JSON text, or null for a call already handled.
   */
  async callTool(callId: string, name: string, argsText: string): Promise<string | null> {
    if (this.toolCalls.has(callId)) return null;
    this.toolCalls.add(callId);
    this.turnTools++;
    let args: unknown;
    try { args = JSON.parse(argsText || '{}'); } catch { args = null; }
    this.pending++;
    try {
      const { output, controls } = args === null
        ? { output: { ok: false, outcome: 'invalid_arguments', say: 'Those arguments were not valid JSON. Call the tool again.', data: {} }, controls: [] }
        : await this.agent.onToolCall(name, args);
      this.answerDue = true;
      this.syncManual();
      if (!this.closed) await this.dispatch(controls);
      return JSON.stringify(output);
    } finally {
      this.pending--;
    }
  }

  /** Manual replies on, once a pet or patient is found (and off again if the call is ending). */
  private syncManual() {
    if (!this.manualTurns || this.closed) return;
    const want = this.agent.repliesAfterWords();
    if (want === this.manual) return;
    this.manual = want;
    this.sideband.send({ type: 'turns.manual', event_id: `manual_${randomUUID()}`, on: want });
  }

  /** After the caller's words, with replies ours to start: the lookup they ask for, handed to the voice, then the go. */
  private async replyAfterWords() {
    try {
      const spec = this.agent.speculate();
      if (spec) {
        const callId = `spec_${randomUUID()}`;
        const args = JSON.stringify(spec.args);
        const output = await this.callTool(callId, spec.name, args);
        if (output !== null && !this.closed) {
          this.log.info({ session_id: this.sessionId, tool: spec.name }, 'lookup run ahead of the reply');
          this.sideband.send({ type: 'tool.inject', event_id: `inject_${callId}`, call_id: callId, name: spec.name, arguments: args, output });
        }
      }
    } finally {
      // whatever happened to the lookup, the voice replies now
      if (!this.closed) this.sideband.send({ type: 'reply.go', event_id: `go_${randomUUID()}` });
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
        this.ending = o.type;
        const act = () => (o.type === 'transfer' ? this.engine.transfer(this.sessionId, o.uri) : this.engine.hangup(this.sessionId))
          .catch((err) => {
            // a hang-up the line beat to it: the caller is gone already (OpenAI answers 404 "No session found"). Nothing
            // failed and nobody is told (note 45, A6: logged as an error after a normal goodbye)
            if (o.type === 'hangup' && (this.closed || (err as { status?: number }).status === 404)) {
              this.log.info({ session_id: this.sessionId }, 'the call had already ended before the hang-up');
              return;
            }
            this.log.error({ session_id: this.sessionId, err }, `${o.type} failed`);
            // the caller is still there: tell staff, and have the assistant offer a callback
            this.ending = null;
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
   * Twice a second, checks no model can be trusted to make on its own:
   * - the caller finished speaking and nothing came back (no answer, no tool at work):
   *   their words go back to the assistant to answer now, at 5 s and again at 12 s;
   * - the assistant said goodbye and the line has been quiet since: the call is ended.
   * Neither runs while a transfer or a hang-up is on its way, or after the call ends.
   */
  private watch() {
    if (this.watchdog || this.closed) return;
    this.watchdog = setInterval(() => { void this.check().catch((err) => this.log.warn({ session_id: this.sessionId, err }, 'call check failed')); }, CHECK_MS);
    this.watchdog.unref?.();
  }

  /**
   * Nobody has said a word since the call was answered, and no audio of the assistant's has reached the line: the
   * greeting is overdue, and is asked for once more, as a commentary (an instruction starts no turn). Never once any
   * audio has started: its transcript lags it, and a nudge in that gap restarted the greeting (2026-10-29).
   */
  private async openingCheck() {
    if (this.closed || this.ending || this.agent.state.endedByStaff || this.openingNudged || this.audioStartedAt || this.agentSpokeAt || this.callerSaidAt) return;
    this.openingNudged = true;
    this.marks.mark('nudged');
    this.log.info({ session_id: this.sessionId, ms: Date.now() - this.startedAt }, 'the assistant has not greeted the caller: nudging it');
    this.sideband.send({ type: 'session.commentary.append', event_id: `opening_nudge_${this.sessionId}`, delegation_id: null, content: OPENING_NUDGE });
  }

  /**
   * The assistant has not said a word SILENT_START_DEADLINE_MS after the call was answered, nudge or not: the caller is
   * put through to the front desk, or the call ends, instead of a silent line until the session expires. Never once any
   * of the assistant's audio or words reached the line, nor while staff or a transfer are already on it.
   */
  private async silentStartCheck() {
    if (this.silentStartUri === undefined || this.silentStartHandled) return;
    if (this.closed || this.ending || this.agent.state.endedByStaff || this.audioStartedAt || this.agentSpokeAt) return;
    this.silentStartHandled = true;
    this.marks.mark('silent_start');
    const uri = this.silentStartUri;
    this.log.warn({ session_id: this.sessionId, ms: Date.now() - this.startedAt, to: uri ? 'front_desk' : 'end', caller_spoke: !!this.callerSaidAt }, 'the assistant never spoke: the caller is not left in silence');
    await this.dispatch(uri ? [{ type: 'transfer', uri }] : [{ type: 'hangup' }]);
  }

  /** The one timing line per call: at the first words, or at the end of a call that never had any. */
  private timing() {
    if (this.timed) return;
    this.timed = true;
    this.log.info({ session_id: this.sessionId, ...this.marks.line(), nudged: this.openingNudged }, 'call setup timing');
  }

  private async check() {
    if (this.closed || this.ending || this.agent.state.endedByStaff) return;
    const now = Date.now();
    // the end of a reply, for the logs: its words have stopped and their audio should have played
    if (this.speaking && now - this.agentSpokeAt >= QUIET_MS && now >= this.speakingUntil) {
      this.speaking = false;
      this.log.info({ session_id: this.sessionId }, 'assistant stopped speaking');
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
    // a caller whose last words were a goodbye is not waiting: a nudge there made the assistant start talking again (a test call, 2026-10-24)
    const leaving = last?.speaker === 'caller' && saidGoodbye(last.text, agentLast?.text ?? '');
    // and no answer began after the caller stopped: a reply already given is never talked over by a nudge
    if (this.callerSaidAt > this.speakingUntil && this.agentSpokeAt < this.callerSaidAt && !this.pending && !leaving && this.nudged < SILENCE_NUDGE_MS.length && now - this.callerSaidAt >= SILENCE_NUDGE_MS[this.nudged]!) {
      this.nudged++;
      this.log.info({ session_id: this.sessionId, nudge: this.nudged, waited_ms: now - this.callerSaidAt }, 'the caller is waiting in silence: giving the assistant their words to answer');
      // the first nudge of a turn is a stall: the caller spoke and heard nothing back for 5 s, and nothing was at work
      if (this.nudged === 1) {
        this.stalls++;
        this.alerts?.alert('stalled_turn', `A caller waited ${Math.round((now - this.callerSaidAt) / 1000)} s in silence after speaking, with nothing being looked up.${this.alerts.where ? '' : ` Session ${this.sessionId}.`}`);
      }
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
    this.timing();
    // a change waiting for a yes when the line went becomes a request for the team (note 45, A4), before the outcome is read
    await this.agent.onCallEnd();
    const state = this.agent.state;
    // a hang-up staff asked for is recorded as theirs; a dropped line is still a dropped line
    if (state.endedByStaff && !note && reason !== 'connection_lost') reason = 'ended_by_staff';
    // a call the deadline took off a silent line says so as its close reason, wherever it went
    if (this.silentStartHandled && !note) reason = 'silent_start';
    // with the two markers of how the call went for the caller, from its turns (CALL-3): the longest wait after they
    // spoke, and the questions asked again
    const quality: CallQuality = { ...this.quality(), maxGapMs: maxGapMs(state.turns), repeatedQuestions: repeatedQuestions(state.turns).length };
    // the caller never heard the assistant: recorded as such, and said when the line was up long enough to matter
    const outcome = recordedOutcome(state.outcome, quality);
    const lasted = Date.now() - this.startedAt;
    if (quality.firstAudioMs === null && lasted >= EMPTY_CALL_MIN_MS) {
      this.alerts?.alert('empty_call', `A caller was on the line ${Math.round(lasted / 1000)} s and never heard the assistant (${note ?? reason}).${this.alerts.where ? '' : ` Session ${this.sessionId}.`}`);
    }
    await this.recorder.close({ reason: note ?? reason, voiceSeconds, outcome, emergency: !!state.emergency, emergencyResult: state.emergencyResult, language: state.language, quality, usage: { models: state.modelTokens, fastTier: state.fastTier } });
    this.log.info({ session_id: this.sessionId, reason, outcome, voice_seconds: voiceSeconds, first_audio_ms: quality.firstAudioMs, stalls: quality.stalls, answer_timeouts: quality.answerTimeouts, max_gap_ms: quality.maxGapMs, repeated_questions: quality.repeatedQuestions,
      // the tokens each model used (counts only), the same numbers call_costs prices: a cost can be read off the logs
      model_tokens: state.modelTokens }, 'call finished');
    this.sideband.close();
  }
}
