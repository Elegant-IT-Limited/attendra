// SPDX-License-Identifier: AGPL-3.0-only
// Injection tokens. Every constructor names its token, so nothing depends on
// emitted type metadata (tsx and Vitest do not emit it).
export const DB = Symbol('db');
export const CIPHER = Symbol('cipher');
export const AUTH = Symbol('auth');
export const FRONT_DESK = Symbol('front-desk');
export const SCHEDULE = Symbol('schedule');
export const PATIENTS = Symbol('patients');
export const STAFF_SCHEDULER = Symbol('staff-scheduler');
/** The time the API thinks it is. Tests move it; everything else uses the real clock. */
export const CLOCK = Symbol('clock');
export const API_OPTIONS = Symbol('api-options');
export const LOGGER = Symbol('logger');
export const VOICE = Symbol('voice');
export const JOBS = Symbol('jobs');
export const KNOWLEDGE = Symbol('knowledge');
export const EVENTS = Symbol('events');
export const WEBHOOK_GUARD = Symbol('webhook-guard');

/** Starts and ends browser test calls on the voice service. Null when the deployment has none. */
export interface LiveCallSummary {
  callId: string; channel: 'phone' | 'web'; startedAt: string; verified: string | null; doing: string | null; waitingForYes: boolean; emergency: boolean;
}

/** A staff action's answer: done, the same click again, or refused with a reason. */
export type LiveActionResult = { ok: true; repeat: boolean } | { ok: false; status: number; error: string; by?: string };

export interface VoiceClient {
  /** Whether the voice service takes real browser test calls (it may only run simulated ones). */
  readonly browserCalls: boolean;
  /** Whether it can play a scripted call with no audio, for the demo. */
  readonly simulatedCalls: boolean;
  startTestCall(clinicId: string, userId: string, sdpOffer: string): Promise<{ callId: string; sdp: string; maxSeconds: number }>;
  endTestCall(clinicId: string, callId: string): Promise<void>;
  startSimulatedCall(clinicId: string, userId: string): Promise<{ callId: string }>;
  liveCalls(clinicId: string): Promise<LiveCallSummary[]>;
  /** The call's event stream, or null when it is not live. The body is Server-Sent Events. */
  liveStream(clinicId: string, callId: string, lastEventId: string | null, signal: AbortSignal): Promise<ReadableStream<Uint8Array> | null>;
  coach(clinicId: string, callId: string, a: { userId: string; key: string; note: string }): Promise<LiveActionResult>;
  takeOver(clinicId: string, callId: string, a: { userId: string; key: string; target: { kind: 'front_desk' } | { kind: 'number'; number: string } }): Promise<LiveActionResult>;
  endCall(clinicId: string, callId: string, a: { userId: string; key: string }): Promise<LiveActionResult>;
}

export interface ApiOptions {
  publicUrl: string;
  demoMode: boolean;
  /** Printed on the sign-in page. Only `pnpm demo` sets it: a deployed demo keeps its password private. */
  demoSignIn?: { password: string; logins: { email: string; label: string }[] };
}
