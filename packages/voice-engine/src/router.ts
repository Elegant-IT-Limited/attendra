// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, openAiEngineOf } from '@attendra/core';
import type { CallOptions, Sideband, VoiceEngine } from './engine';

/**
 * The engines a deployment has (GPT-Live, and the Realtime models when set up), and which
 * one each call uses: the clinic's choice (`voiceEngine`, set by the operator), or the
 * deployment's default. Every later step of a call goes to the engine that took it.
 */
export class EngineRouter implements VoiceEngine {
  readonly name = 'router';
  private readonly bySession = new Map<string, VoiceEngine>();

  constructor(private readonly engines: Record<string, VoiceEngine>, private readonly fallback: string) {
    if (!engines[fallback]) throw new Error(`no engine named ${fallback}`);
  }

  /**
   * The engine for a clinic: its own choice when this deployment has it, else the default. A clinic on Vapi whose call
   * still reaches us (a browser test call, or Twilio's overflow to our SIP path) gets the engine it had before (batch 6).
   */
  engineFor(clinic: Pick<ClinicConfig, 'voiceEngine' | 'vapi'>): VoiceEngine {
    const own = openAiEngineOf(clinic);
    return (own && this.engines[own]) || this.engines[this.fallback]!;
  }

  /** The engine with this name, for a phone call that arrived on it (OpenAI decides that by the kind of call). */
  named(name: string): VoiceEngine | null {
    return this.engines[name] ?? null;
  }

  private of(sessionId: string) {
    return this.bySession.get(sessionId) ?? this.engines[this.fallback]!;
  }

  /** Takes a phone call with a given engine, whatever the clinic chose: the call came in on it. */
  async acceptWith(engine: VoiceEngine, sessionId: string, clinic: ClinicConfig, now: Date, opening?: string, opts: CallOptions = {}) {
    this.bySession.set(sessionId, engine);
    await engine.accept(sessionId, clinic, now, opening, opts);
  }

  async accept(sessionId: string, clinic: ClinicConfig, now: Date, opening?: string, opts: CallOptions = {}) {
    return this.acceptWith(this.engineFor(clinic), sessionId, clinic, now, opening, opts);
  }

  async startBrowserCall(clinic: ClinicConfig, sdpOffer: string, now: Date, opts: CallOptions = {}) {
    const engine = this.engineFor(clinic);
    const started = await engine.startBrowserCall(clinic, sdpOffer, now, opts);
    this.bySession.set(started.sessionId, engine);
    return started;
  }

  reject(sessionId: string, sipStatus: number) { return this.of(sessionId).reject(sessionId, sipStatus); }
  attach(sessionId: string): Sideband { return this.of(sessionId).attach(sessionId); }
  transfer(sessionId: string, targetUri: string) { return this.of(sessionId).transfer(sessionId, targetUri); }
  hangup(sessionId: string) { return this.of(sessionId).hangup(sessionId); }

  sessionInfo(sessionId: string) { return this.of(sessionId).sessionInfo?.(sessionId) ?? null; }

  release(sessionId: string) {
    this.of(sessionId).release?.(sessionId);
    this.bySession.delete(sessionId);
  }
}
