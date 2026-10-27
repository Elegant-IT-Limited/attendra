// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from '@attendra/core';
import OpenAI from 'openai';
import type { DataChannelConfig } from 'openai/resources/live/live';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import type { Sideband, SidebandEvent, VoiceEngine } from './engine';
import { conversationPrompt, noCallerIdLine, openingIfNotStarted, openingInstruction } from './prompt';

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
   * Phone sessions that still have to be told to greet, with what to say: sent once, when the sideband attaches. A browser
   * session has the same opening in its input from creation, and its audio is up only after the browser has the answer:
   * an opening sent on attach reached it before then, a second time (2026-10-26: neither test call greeted within 4 s).
   */
  private readonly openings = new Map<string, string>();

  constructor(
    private readonly client: OpenAI,
    private readonly model = 'gpt-live-1',
    private readonly openSideband: (sessionId: string) => SidebandSocket = (id) => new SidebandWS(client, { session_id: id }, { reconnect: SIDEBAND_RECONNECT }),
  ) {}

  /** The voice each session was created with: set once, never changed in the call (no session.update is ever sent). */
  private readonly voices = new Map<string, string>();

  sessionInfo(sessionId: string) {
    const voice = this.voices.get(sessionId);
    return voice ? { engine: this.name, voice } : null;
  }

  private session(clinic: ClinicConfig, now: Date, opening = openingInstruction(clinic)) {
    return {
      model: this.model,
      instructions: conversationPrompt(clinic, now),
      // GPT-Live waits for the caller unless told to speak first (OpenAI: "Greet before the caller speaks")
      input: [{ type: 'message' as const, role: 'developer' as const, content: [{ type: 'input_text' as const, text: opening }] }],
      audio: { output: { voice: clinic.voice } },
      // client delegation: our backend runs every tool, so identity checks,
      // confirmations and audit stay in code we own
      delegation: { type: 'client' as const },
      store: false, // nothing kept on OpenAI's side beyond the call (Zero Data Retention)
    };
  }

  async accept(sessionId: string, clinic: ClinicConfig, now: Date, opening = openingInstruction(clinic)) {
    await this.client.live.sessions.accept(sessionId, { session: { type: 'live', ...this.session(clinic, now, opening) } });
    this.openings.set(sessionId, opening);
    this.voices.set(sessionId, clinic.voice);
  }

  async startBrowserCall(clinic: ClinicConfig, sdpOffer: string, now: Date) {
    // no retries: a retried create would be a second, billed session
    const session = this.session(clinic, now);
    const created = await this.client.live.create({
      // no caller ID on a browser call: the voice asks for the best number, once
      session: { ...session, instructions: `${session.instructions}\n${noCallerIdLine(clinic)}`, client: { data_channel: BROWSER_DATA_CHANNEL } },
      transport: { type: 'webrtc', sdp: sdpOffer },
    }, { timeout: 10_000, maxRetries: 0 });
    this.browser.add(created.session.id);
    this.voices.set(created.session.id, clinic.voice);
    return { sessionId: created.session.id, sdpAnswer: created.transport.sdp };
  }

  async reject(sessionId: string, sipStatus: number) {
    await this.client.live.sessions.reject(sessionId, { status_code: sipStatus });
  }

  attach(sessionId: string): Sideband {
    const ws = this.openSideband(sessionId);
    // the same opening again, once, now that we can reach the session; the SDK holds it until the socket opens. By then
    // the greeting may be under way or the caller may have spoken over it: it never starts the greeting over
    const opening = this.openings.get(sessionId);
    if (opening) {
      this.openings.delete(sessionId);
      ws.send({ type: 'session.instructions.append', event_id: `opening_${sessionId}`, delegation_id: null, content: openingIfNotStarted(opening) } as never);
    }
    if (this.browser.has(sessionId)) {
      this.sockets.set(sessionId, ws);
      ws.on('close', () => { if (this.sockets.get(sessionId) === ws) this.sockets.delete(sessionId); });
    }
    return {
      send: (event) => ws.send(event),
      onEvent: (handler) => ws.on('event', (e) => handler(e as SidebandEvent)),
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
    this.browser.delete(sessionId);
    this.openings.delete(sessionId);
    this.sockets.delete(sessionId);
    this.voices.delete(sessionId);
  }
}
