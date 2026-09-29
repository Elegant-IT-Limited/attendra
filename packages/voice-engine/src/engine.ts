// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from '@attendra/core';
import type { CommentaryAppendEvent, InstructionsAppendEvent, ThinkingAppendEvent } from 'openai/resources/live/live';

/**
 * Everything engine-specific sits behind this interface. GPT-Live with client
 * delegation is the default; the Realtime API engine (gpt-realtime) is the planned
 * fallback and will implement the same operations plus the same event stream.
 */
export interface VoiceEngine {
  readonly name: string;
  accept(sessionId: string, clinic: ClinicConfig, now: Date): Promise<void>;
  /**
   * Starts a conversation with a browser instead of a phone: takes the browser's
   * WebRTC offer, returns the session id and the answer for the browser to apply.
   * The session is then attached and run exactly like a phone call.
   */
  startBrowserCall(clinic: ClinicConfig, sdpOffer: string, now: Date): Promise<{ sessionId: string; sdpAnswer: string }>;
  reject(sessionId: string, sipStatus: number): Promise<void>;
  attach(sessionId: string): Sideband;
  transfer(sessionId: string, targetUri: string): Promise<void>;
  hangup(sessionId: string): Promise<void>;
  /** Forgets a finished session. Engines that keep no per-session state can leave it out. */
  release?(sessionId: string): void;
}

/** The sideband control socket: our backend's view of a live conversation. */
export interface Sideband {
  send(event: SidebandCommand): void;
  onEvent(handler: (event: SidebandEvent) => void): void;
  /** Server error events and socket errors. Without a listener the SDK reports them as unhandled. */
  onError(handler: (err: Error) => void): void;
  onClose(handler: (code: number) => void): void;
  close(): void;
}

/** The three append commands the agent uses, typed by the SDK. */
export type SidebandCommand = ThinkingAppendEvent | CommentaryAppendEvent | InstructionsAppendEvent;

/** The subset of server events the call runner reads. Everything else is ignored. */
export type SidebandEvent =
  | { type: 'session.input_transcript.delta' | 'session.output_transcript.delta'; event_id: string; delta: string; start_ms: number; end_ms: number }
  | { type: 'session.delegation.created'; event_id: string; delegation: { id: string; target: string } }
  | { type: 'session.closed'; event_id: string; reason: string; usage?: { seconds?: number } }
  | { type: 'error'; event_id: string; error?: { code?: string; message?: string } }
  | { type: string; event_id: string };
