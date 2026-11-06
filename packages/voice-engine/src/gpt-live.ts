// SPDX-License-Identifier: AGPL-3.0-only
import { voiceToolDefinitions } from '@attendra/agent';
import type { ClinicConfig, VoiceFlow } from '@attendra/core';
import OpenAI from 'openai';
import type { DataChannelConfig } from 'openai/resources/live/live';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import type { CallOptions, Sideband, SidebandCommand, SidebandEvent, VoiceEngine } from './engine';
import { callerIdLine, conversationPrompt, noCallerIdLine, openingInstruction } from './prompt';
import { toolsBackendInstructions, toolsLivePrompt } from './tools-prompt';

/**
 * The Responses model GPT-Live hands tasks to on the tools path, with our tools (OpenAI's Responses delegation): which
 * model, how hard it thinks, and its processing tier. Path B of the bake-off; path A is gpt-realtime calling them itself.
 */
export interface ToolsBackend { model: string; effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high'; tier?: 'auto' | 'default' | 'flex' | 'priority' }
export const DEFAULT_TOOLS_BACKEND: ToolsBackend = { model: 'gpt-6-luna', effort: 'low' };

/**
 * A delegated Responses event, inside GPT-Live's `response.event`, as the sideband reads it: a function call of ours
 * when the item is done, the response's tokens when it completes. Everything else in the stream is not ours to act on.
 */
export function fromDelegatedResponse(e: { event_id: string; event?: Record<string, unknown> }): SidebandEvent | null {
  const inner = e.event ?? {};
  const item = inner.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
  if (inner.type === 'response.output_item.done' && item?.type === 'function_call' && item.call_id && item.name) {
    return { type: 'session.tool_call', event_id: e.event_id, call_id: item.call_id, name: item.name, arguments: item.arguments ?? '{}' };
  }
  const response = inner.response as { model?: string; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } | undefined;
  if (inner.type === 'response.completed' && response?.usage) {
    return { type: 'session.model_usage', event_id: e.event_id, model: response.model ?? 'unknown', input: response.usage.input_tokens ?? 0, cached: response.usage.input_tokens_details?.cached_tokens ?? 0, output: response.usage.output_tokens ?? 0 };
  }
  return null;
}

/**
 * What a browser tab may see and do on its own data channel. It is untrusted, so
 * it can only end the conversation and read the live captions; it can never add
 * instructions or context. Our sideband is unaffected and stays in charge.
 */
export const BROWSER_DATA_CHANNEL = {
  allowed_client_events: ['session.close'],
  allowed_server_events: [
    { type: 'session.started' },
    { type: 'session.closed' },
    { type: 'session.input_transcript.delta' },
    { type: 'session.output_transcript.delta' },
  ],
} satisfies DataChannelConfig;

/** How long ending a detached browser session may take before we give up on it. */
const CLOSE_TIMEOUT_MS = 5000;

/** The part of the SDK's sideband socket the engine uses; tests pass a fake. */
export type SidebandSocket = Pick<SidebandWS, 'send' | 'on' | 'close'> & { socket: { readyState: number; on(event: 'open', handler: () => void): unknown } };

/**
 * A sideband that drops comes back on its own, a few times, to the same session: without it a dropped socket left the
 * voice talking to a caller with nobody answering its hand-offs. What is sent meanwhile waits in the SDK's queue.
 */
const SIDEBAND_RECONNECT = { maxRetries: 4, initialDelay: 250, maxDelay: 2000, onReconnecting: () => undefined };

/**
 * GPT-Live, over direct SIP for phone calls and WebRTC for test calls from the
 * dashboard. Either way we configure the session with the clinic's settings and
 * attach a sideband socket; call audio never passes through our servers.
 */
export class GptLiveEngine implements VoiceEngine {
  readonly name = 'gpt-live';

  /** Browser sessions have no SIP leg: they end with session.close, never with the SIP endpoints. */
  private readonly browser = new Set<string>();
  private readonly sockets = new Map<string, SidebandSocket>();
  /**
   * Phone sessions that still have to be told to greet, with what to say. The developer message in the session's input
   * "can improve greeting behavior, but does not guarantee that the model will speak" (OpenAI); what makes it speak is the
   * same greeting sent once as a commentary after `session.started`, which the call runner does (`opening()`). An
   * instructions append on attach, the old way, started no turn: on 10 of 12 real phone calls (2026-10-29) the assistant
   * said nothing until nudged or spoken to, and on 5 of them nothing at all. A browser session has the opening in its
   * input from creation and its audio is up only after the browser has the answer: it is never sent again.
   */
  private readonly openings = new Map<string, string>();

  /** How each session's turns are answered: client delegation to the planner, or Responses delegation with our tools. */
  private readonly flows = new Map<string, VoiceFlow>();

  constructor(
    private readonly client: OpenAI,
    private readonly model = 'gpt-live-1',
    private readonly openSideband: (sessionId: string) => SidebandSocket = (id) => new SidebandWS(client, { session_id: id }, { reconnect: SIDEBAND_RECONNECT }),
    private readonly toolsBackend: ToolsBackend = DEFAULT_TOOLS_BACKEND,
  ) {}

  /** The voice each session was created with: set once, never changed in the call (no session.update is ever sent). */
  private readonly voices = new Map<string, string>();

  sessionInfo(sessionId: string) {
    const voice = this.voices.get(sessionId);
    return voice ? { engine: this.name, voice } : null;
  }

  /**
   * `line`: what this call's caller ID (or its lack) means for the number question, at the end of the instructions.
   * On the tools path the Live model hands every task to a Responses model of OpenAI's that runs our tools (answered
   * by us over the sideband); the instructions are the tools prompt's, with no clinic policy in either.
   */
  private session(clinic: ClinicConfig, now: Date, opening = openingInstruction(clinic), line: string | null = null, opts: CallOptions = {}) {
    if (opts.flow === 'tools') {
      const b = this.toolsBackend;
      return {
        model: this.model,
        instructions: toolsLivePrompt(clinic, { callerNumber: opts.callerNumber }),
        input: [{ type: 'message' as const, role: 'developer' as const, content: [{ type: 'input_text' as const, text: opening }] }],
        audio: { output: { voice: clinic.voice } },
        delegation: {
          type: 'responses' as const,
          responses: {
            model: b.model, instructions: toolsBackendInstructions(clinic), tools: voiceToolDefinitions(clinic), parallel_tool_calls: false,
            ...(b.effort ? { reasoning: { effort: b.effort } } : {}), ...(b.tier ? { service_tier: b.tier } : {}),
          },
        },
        store: false,
      };
    }
    return {
      model: this.model,
      instructions: line ? `${conversationPrompt(clinic, now)}\n${line}` : conversationPrompt(clinic, now),
      // GPT-Live waits for the caller unless told to speak first (OpenAI: "Greet before the caller speaks")
      input: [{ type: 'message' as const, role: 'developer' as const, content: [{ type: 'input_text' as const, text: opening }] }],
      audio: { output: { voice: clinic.voice } },
      // client delegation: our backend runs every tool, so identity checks,
      // confirmations and audit stay in code we own
      delegation: { type: 'client' as const },
      store: false, // nothing kept on OpenAI's side beyond the call (Zero Data Retention)
    };
  }

  async accept(sessionId: string, clinic: ClinicConfig, now: Date, opening = openingInstruction(clinic), opts: CallOptions = {}) {
    const line = opts.callerNumber ? callerIdLine(clinic, opts.callerNumber) : null;
    await this.client.live.sessions.accept(sessionId, { session: { type: 'live', ...this.session(clinic, now, opening, line, opts) } });
    this.openings.set(sessionId, opening);
    this.voices.set(sessionId, clinic.voice);
    this.flows.set(sessionId, opts.flow ?? 'planner');
  }

  async startBrowserCall(clinic: ClinicConfig, sdpOffer: string, now: Date, opts: CallOptions = {}) {
    // no retries: a retried create would be a second, billed session. No caller ID on a browser call: the voice asks the
    // number the pet's profile is under itself, for a visit only (a clinic for people: the best number); unless staff
    // started it as a number ("Call as"), when it has caller ID like a phone call
    const line = opts.callerNumber ? callerIdLine(clinic, opts.callerNumber) : noCallerIdLine(clinic);
    const session = this.session(clinic, now, undefined, line, opts);
    const created = await this.client.live.create({
      session: { ...session, client: { data_channel: BROWSER_DATA_CHANNEL } },
      transport: { type: 'webrtc', sdp: sdpOffer },
    }, { timeout: 10_000, maxRetries: 0 });
    this.browser.add(created.session.id);
    this.voices.set(created.session.id, clinic.voice);
    this.flows.set(created.session.id, opts.flow ?? 'planner');
    return { sessionId: created.session.id, sdpAnswer: created.transport.sdp };
  }

  async reject(sessionId: string, sipStatus: number) {
    await this.client.live.sessions.reject(sessionId, { status_code: sipStatus });
  }

  /** The opening a phone session still owes, once: the runner sends it when the session starts. */
  opening(sessionId: string): string | null {
    const opening = this.openings.get(sessionId) ?? null;
    this.openings.delete(sessionId);
    return opening;
  }

  attach(sessionId: string): Sideband {
    const ws = this.openSideband(sessionId);
    if (this.browser.has(sessionId)) {
      this.sockets.set(sessionId, ws);
      ws.on('close', () => { if (this.sockets.get(sessionId) === ws) this.sockets.delete(sessionId); });
    }
    const toolsPath = this.flows.get(sessionId) === 'tools';
    // the delegated response's tool calls still waiting for their results: it goes on once all of them are back
    const outstanding = new Set<string>();
    const send = (event: SidebandCommand) => {
      if (event.type !== 'tool.result') return ws.send(event);
      ws.send({ type: 'response.item.create', event_id: event.event_id, item: { type: 'function_call_output', call_id: event.call_id, output: event.output } });
      outstanding.delete(event.call_id);
      if (!outstanding.size) ws.send({ type: 'response.create', event_id: `${event.event_id}_go` });
    };
    return {
      send,
      onEvent: (handler) => ws.on('event', (e) => {
        const ev = e as SidebandEvent & { event?: Record<string, unknown> };
        // the tools path: our tool calls and the backend's tokens, out of the delegated response's own stream
        if (toolsPath && ev.type === 'response.event') {
          const ours = fromDelegatedResponse(ev);
          if (ours?.type === 'session.tool_call') outstanding.add((ours as { call_id: string }).call_id);
          if (ours) handler(ours);
          return;
        }
        handler(ev);
      }),
      onError: (handler) => ws.on('error', (err) => handler(err)),
      // the SDK's close: for good, after any reconnecting has given up (a drop it recovers from is not the end of the call)
      onClose: (handler) => ws.on('close', (code: number) => handler(code)),
      onConnection: (handler) => {
        ws.socket.on('open', () => handler({ state: 'open' }));
        ws.on('reconnecting', (e) => handler({ state: 'reconnecting', attempt: e.attempt, code: e.closeCode }));
        ws.on('reconnected', () => handler({ state: 'reconnected' }));
      },
      close: () => ws.close(),
    };
  }

  async transfer(sessionId: string, targetUri: string) {
    if (this.browser.has(sessionId)) throw new Error('a browser test call cannot be transferred');
    await this.client.live.sessions.refer(sessionId, { target_uri: targetUri });
  }

  async hangup(sessionId: string) {
    if (!this.browser.has(sessionId)) return this.client.live.sessions.hangup(sessionId);
    const ws = this.sockets.get(sessionId);
    // connecting (0) or open (1): the SDK queues the command until the socket is open
    if (ws && ws.socket.readyState <= 1) return void ws.send({ type: 'session.close' });
    // Not attached yet, or the sideband dropped while the browser is still talking:
    // connect just to end the session. The SDK queues the command until the socket opens.
    const temp = this.openSideband(sessionId);
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, CLOSE_TIMEOUT_MS);
      temp.on('event', (e) => { if ((e as SidebandEvent).type === 'session.closed') done(); });
      temp.on('error', done);
      temp.on('close', done);
      temp.send({ type: 'session.close' });
    });
    temp.close();
  }

  release(sessionId: string) {
    this.flows.delete(sessionId);
    this.browser.delete(sessionId);
    this.openings.delete(sessionId);
    this.sockets.delete(sessionId);
    this.voices.delete(sessionId);
  }
}
