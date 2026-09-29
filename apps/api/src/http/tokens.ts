// SPDX-License-Identifier: AGPL-3.0-only
// Injection tokens. Every constructor names its token, so nothing depends on
// emitted type metadata (tsx and Vitest do not emit it).
export const DB = Symbol('db');
export const AUTH = Symbol('auth');
export const FRONT_DESK = Symbol('front-desk');
export const API_OPTIONS = Symbol('api-options');
export const LOGGER = Symbol('logger');
export const VOICE = Symbol('voice');

/** Starts and ends browser test calls on the voice service. Null when the deployment has none. */
export interface VoiceClient {
  startTestCall(clinicId: string, userId: string, sdpOffer: string): Promise<{ callId: string; sdp: string; maxSeconds: number }>;
  endTestCall(clinicId: string, callId: string): Promise<void>;
}

export interface ApiOptions {
  publicUrl: string;
  demoMode: boolean;
  /** Printed on the sign-in page. Only `pnpm demo` sets it: a deployed demo keeps its password private. */
  demoSignIn?: { password: string; logins: { email: string; label: string }[] };
}
