// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig, VoiceFlow } from '@attendra/core';
import type { CommentaryAppendEvent, InstructionsAppendEvent, ThinkingAppendEvent } from 'openai/resources/live/live';

/**
 * Everything engine-specific sits behind this interface. GPT-Live with client
 * delegation is the default; the Realtime API engine (gpt-realtime) is the planned
 * fallback and will implement the same operations plus the same event stream.
 */
export interface VoiceEngine {
  readonly name: string;
  /**
   * `opening`: what to say first, when not the clinic's usual greeting (a VIP's hello). `callerNumber`: the caller ID, so
   * the voice knows from the start to ask the number question for a visit (callerIdLine).
   */
  accept(sessionId: string, clinic: ClinicConfig, now: Date, opening?: string, opts?: CallOptions): Promise<void>;
  /**
   * Starts a conversation with a browser instead of a phone: takes the browser's
   * WebRTC offer, returns the session id and the answer for the browser to apply.
   * The session is then attached and run exactly like a phone call. `callerNumber`: staff
   * started it as a number ("Call as"), so it has caller ID like a phone call.
   */
  startBrowserCall(clinic: ClinicConfig, sdpOffer: string, now: Date, opts?: CallOptions): Promise<{ sessionId: string; sdpAnswer: string }>;
  reject(sessionId: string, sipStatus: number): Promise<void>;
  attach(sessionId: string): Sideband;
  transfer(sessionId: string, targetUri: string): Promise<void>;
  hangup(sessionId: string): Promise<void>;
  /** Forgets a finished session. Engines that keep no per-session state can leave it out. */
  release?(sessionId: string): void;
  /** Which engine took a session and the voice it was created with: set once, at creation, never changed in the call. */
  sessionInfo?(sessionId: string): { engine: string; voice: string } | null;
  /**
   * What the assistant is to say first on this session, given once: the runner sends it the moment the
   * session starts. Null when the engine greets by itself (the Realtime engine), when the session has its
   * opening already (a browser call) or once it has been taken.
   */
  opening?(sessionId: string): string | null;
}

/**
 * How a call is set up. `callerNumber`: the caller ID. `flow`: how its turns are answered, 'planner' (one hand-off per
 * turn to our planner, the default) or 'tools' (the voice calls the tools API itself: gpt-realtime with function tools,
 * GPT-Live with Responses delegation running the same tools). An engine without a tools mode answers with the planner.
 */
export interface CallOptions { callerNumber?: string | null; flow?: VoiceFlow }

/** The sideband's own connection: open, dropped and coming back (the attempt, and the close code that started it), back. */
export type SidebandConnection = { state: 'open' } | { state: 'reconnecting'; attempt: number; code: number } | { state: 'reconnected' };

/** The sideband control socket: our backend's view of a live conversation. */
export interface Sideband {
  send(event: SidebandCommand): void;
  onEvent(handler: (event: SidebandEvent) => void): void;
  /** Server error events and socket errors. Without a listener the SDK reports them as unhandled. */
  onError(handler: (err: Error) => void): void;
  onClose(handler: (code: number) => void): void;
  /** The connection opening, dropping and coming back, for the logs and for answers a drop may have lost. */
  onConnection?(handler: (e: SidebandConnection) => void): void;
  close(): void;
}

/**
 * The three append commands the agent uses, typed by the SDK, and on the tools path a tool's result for the engine to
 * hand back to whichever model called it (a Realtime function call, a GPT-Live delegated Responses call).
 */
export type SidebandCommand = ThinkingAppendEvent | CommentaryAppendEvent | InstructionsAppendEvent | ToolResultCommand | ManualTurnsCommand | ToolInjectCommand | ReplyCommand;
export interface ToolResultCommand { type: 'tool.result'; event_id: string; call_id: string; output: string }
/**
 * The tools path, on an engine that can (gpt-realtime): whether the voice waits for our go before it replies to the
 * caller, so a lookup their words ask for can be run first and handed to it (`tool.inject`, then `reply.go`). The engine
 * replies by itself if no go comes in time. Other engines ignore these.
 */
export interface ManualTurnsCommand { type: 'turns.manual'; event_id: string; on: boolean }
export interface ToolInjectCommand { type: 'tool.inject'; event_id: string; call_id: string; name: string; arguments: string; output: string }
export interface ReplyCommand { type: 'reply.go'; event_id: string }

/** The subset of server events the call runner reads. Everything else is ignored. */
export type SidebandEvent =
  | { type: 'session.input_transcript.delta' | 'session.output_transcript.delta'; event_id: string; delta: string; start_ms: number; end_ms: number }
  | { type: 'session.delegation.created'; event_id: string; delegation: { id: string; target: string } }
  // the sideband hears the session start, and a copy of the assistant's audio as it is made: the surest sign it is speaking
  | { type: 'session.started'; event_id: string }
  | { type: 'session.output_audio.delta'; event_id: string; delta: string }
  | { type: 'session.closed'; event_id: string; reason: string; usage?: { seconds?: number } }
  | { type: 'error'; event_id: string; error?: { code?: string; message?: string } }
  // the tools path: a model called one of our tools (`arguments` as JSON text), and what a text model used, for the cost row
  | { type: 'session.tool_call'; event_id: string; call_id: string; name: string; arguments: string }
  | { type: 'session.model_usage'; event_id: string; model: string; input: number; cached: number; output: number }
  | { type: string; event_id: string };
