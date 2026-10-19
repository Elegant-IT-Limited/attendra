// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, PREVIEW_VOICES } from '@attendra/core';
import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import type { Sideband, SidebandCommand, SidebandEvent, VoiceEngine } from './engine';
import { conversationPrompt } from './prompt';

/**
 * The one tool the Realtime model has: ask our backend. It is the same hand-off GPT-Live
 * makes with client delegation, so the backend (identity checks, booking rules,
 * confirmations, texts, transfers) is exactly the same whichever engine answers.
 */
export const ASK_BACKEND = {
  type: 'function' as const,
  name: 'ask_backend',
  description: 'Hand the caller\'s request to the clinic\'s backend, which checks records, finds times, books, texts, transfers and ends calls. Use it for anything about appointments, the caller\'s identity, refills, callbacks, transfers, the clinic\'s staff or facts, texts, or ending the call. Then say what it returns, in your own words, and nothing it did not return.',
  parameters: { type: 'object', properties: { request: { type: 'string', description: 'What the caller wants, in a few words.' } }, required: ['request'], additionalProperties: false },
};

/** What the Realtime model is told on top of the conversation prompt both engines share. */
const REALTIME_LINES = [
  'Whenever the instructions say to delegate to the backend or to wait for the backend, call ask_backend and wait for its result.',
  'You know nothing about this clinic, its staff, its times or its callers except what these instructions say and what ask_backend returns. Never invent a time, a name, a price or a fact.',
  'ask_backend is part of you, not someone else: never mention a backend or a system, never say you are asking or checking with anyone, and never say someone could not hear the caller. Say "let me check", then give what it returns as your own words. A callback from the clinic\'s team is fine to offer.',
];

/** The longest a reply waits for the caller's words before it, when transcription is slow. */
export const TRANSCRIPT_WAIT_MS = 3000;

/** The part of the SDK's call socket the engine uses; tests pass a fake. */
export interface RealtimeSocket {
  send(event: Record<string, unknown>): void;
  on(event: 'event', handler: (e: { type: string; event_id?: string } & Record<string, unknown>) => void): unknown;
  on(event: 'error', handler: (err: Error) => void): unknown;
  close(): void;
  socket: { on(event: 'close', handler: (code: number) => void): unknown };
}

/** A voice GPT-Live has that the Realtime models may not: the clinic's own if it is one of both, else a warm default. */
const voiceFor = (voice: string) => ((PREVIEW_VOICES as readonly string[]).includes(voice) ? voice : 'marin');

/**
 * OpenAI's Realtime models (gpt-realtime-2.1 by default), for phone calls over SIP and
 * test calls from the dashboard over WebRTC. The call runner, the agent and the backend
 * are the same as for GPT-Live: this engine turns the Realtime API's events into the
 * events the runner reads (transcripts, hand-offs, the end of the call) and the
 * runner's commands into Realtime ones. Nothing is stored on OpenAI's side beyond the call.
 */
export class RealtimeEngine implements VoiceEngine {
  readonly name = 'gpt-realtime';
  private readonly browser = new Set<string>();
  /** The instructions each call started with, and what was added since: added text is appended, never lost. */
  private readonly instructions = new Map<string, string>();

  constructor(
    private readonly client: OpenAI,
    private readonly model = 'gpt-realtime-2.1',
    private readonly openSocket: (callId: string) => RealtimeSocket = (id) => new OpenAIRealtimeWS({ callID: id }, client) as unknown as RealtimeSocket,
  ) {}

  private session(clinic: ClinicConfig, now: Date) {
    return {
      type: 'realtime' as const,
      model: this.model,
      instructions: [conversationPrompt(clinic, now), ...REALTIME_LINES].join('\n'),
      audio: {
        input: { transcription: { model: 'gpt-4o-transcribe' }, turn_detection: { type: 'semantic_vad' as const } },
        output: { voice: voiceFor(clinic.voice) },
      },
      tools: [ASK_BACKEND],
      tool_choice: 'auto' as const,
    };
  }

  async accept(callId: string, clinic: ClinicConfig, now: Date) {
    const session = this.session(clinic, now);
    this.instructions.set(callId, session.instructions);
    await this.client.realtime.calls.accept(callId, session);
  }

  async startBrowserCall(clinic: ClinicConfig, sdpOffer: string, now: Date) {
    const session = this.session(clinic, now);
    // no retries: a retried create would be a second, billed call
    const res = await this.client.realtime.calls.create({ sdp: sdpOffer, session }, { timeout: 10_000, maxRetries: 0 });
    // the call's id is the last part of the Location header: /v1/realtime/calls/{call_id}
    const callId = res.headers.get('location')?.split('/').filter(Boolean).at(-1);
    if (!callId) throw new Error('realtime call created without a call id');
    this.browser.add(callId);
    this.instructions.set(callId, session.instructions);
    return { sessionId: callId, sdpAnswer: await res.text() };
  }

  async reject(callId: string, sipStatus: number) {
    await this.client.realtime.calls.reject(callId, { status_code: sipStatus });
  }

  async transfer(callId: string, targetUri: string) {
    if (this.browser.has(callId)) throw new Error('a browser test call cannot be transferred');
    await this.client.realtime.calls.refer(callId, { target_uri: targetUri });
  }

  async hangup(callId: string) {
    await this.client.realtime.calls.hangup(callId);
  }

  release(callId: string) {
    this.browser.delete(callId);
    this.instructions.delete(callId);
  }

  attach(callId: string): Sideband {
    const ws = this.openSocket(callId);
    const started = Date.now();
    const ms = () => Date.now() - started;
    let n = 0;
    const id = (e: { event_id?: string }) => e.event_id ?? `rt_${callId}_${++n}`;
    const handlers: ((e: SidebandEvent) => void)[] = [];
    const emit = (e: SidebandEvent) => { for (const h of handlers) h(e); };

    // The model answers as soon as the caller stops; their words are transcribed after, and
    // can arrive seconds later. Until they do, the reply's words and its hand-off wait, so
    // the record reads in order and the backend plans with what the caller just said.
    const awaiting = new Set<string>();
    let held: SidebandEvent[] = [];
    let timer: NodeJS.Timeout | null = null;
    const release = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      awaiting.clear();
      const out = held;
      held = [];
      for (const e of out) emit(e);
    };
    const reply = (e: SidebandEvent) => {
      if (!awaiting.size) return emit(e);
      held.push(e);
      timer ??= setTimeout(release, TRANSCRIPT_WAIT_MS);
    };
    const heard = (itemId: unknown) => {
      if (typeof itemId === 'string') awaiting.delete(itemId);
      if (!awaiting.size) release();
    };

    ws.on('event', (e) => {
      switch (e.type) {
        case 'input_audio_buffer.committed':
          if (typeof e.item_id === 'string') awaiting.add(e.item_id);
          return;
        // the caller's turn, whole, once it is transcribed
        case 'conversation.item.input_audio_transcription.completed':
          if (typeof e.transcript === 'string' && e.transcript.trim()) emit({ type: 'session.input_transcript.delta', event_id: id(e), delta: e.transcript, start_ms: ms(), end_ms: ms() });
          return heard(e.item_id);
        case 'conversation.item.input_audio_transcription.failed':
          return heard(e.item_id);
        case 'response.output_audio_transcript.delta':
          if (typeof e.delta === 'string' && e.delta) reply({ type: 'session.output_transcript.delta', event_id: id(e), delta: e.delta, start_ms: ms(), end_ms: ms() });
          return;
        // the model hands the caller's request to the backend: the runner answers it like a GPT-Live delegation
        case 'response.function_call_arguments.done':
          if (e.name === ASK_BACKEND.name && typeof e.call_id === 'string') reply({ type: 'session.delegation.created', event_id: id(e), delegation: { id: e.call_id, target: 'client' } });
          return;
        case 'error':
          emit({ type: 'error', event_id: id(e), error: (e.error ?? undefined) as { code?: string; message?: string } | undefined });
          return;
        default:
      }
    });

    const send = (event: SidebandCommand) => {
      const c = event as { type: string; delegation_id: string | null; content: string };
      if (c.type === 'session.commentary.append' && c.delegation_id) {
        // the backend's answer to the hand-off: the tool's result, then the model says it
        ws.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.delegation_id, output: c.content } });
        ws.send({ type: 'response.create' });
      } else if (c.type === 'session.thinking.append') {
        // GPT-Live hears progress notes as context; here only "still working" is said, the rest is silent
        if (/^Still working/.test(c.content)) ws.send({ type: 'response.create', response: { instructions: 'Tell the caller in a few words that you are still checking. Do not answer the question yet.', tool_choice: 'none' } });
      } else {
        // new instructions (an emergency script, a staff note, a nudge): kept for the rest of
        // the call, and acted on now, cutting off whatever the assistant was saying
        const all = `${this.instructions.get(callId) ?? ''}\n${c.content}`;
        this.instructions.set(callId, all);
        ws.send({ type: 'response.cancel' });
        ws.send({ type: 'session.update', session: { type: 'realtime', instructions: all } });
        ws.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: c.content }] } });
        ws.send({ type: 'response.create' });
      }
    };

    return {
      send,
      onEvent: (handler) => { handlers.push(handler); },
      onError: (handler) => { ws.on('error', handler); },
      // a Realtime call has no closing event: a clean close of the call's socket is the end
      // of the call; any other close is a dropped connection, and the runner records it so
      onClose: (handler) => {
        ws.socket.on('close', (code: number) => {
          release();
          if (code === 1000) emit({ type: 'session.closed', event_id: `rt_${callId}_closed`, reason: 'call_ended', usage: { seconds: Math.round(ms() / 1000) } });
          handler(code);
        });
      },
      close: () => ws.close(),
    };
  }
}
