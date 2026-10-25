// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from '@attendra/core';
import type { Sideband, VoiceEngine } from './engine';

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

  /** The engine for a clinic: its own choice when this deployment has it, else the default. */
  engineFor(clinic: Pick<ClinicConfig, 'voiceEngine'>): VoiceEngine {
    return (clinic.voiceEngine && this.engines[clinic.voiceEngine]) || this.engines[this.fallback]!;
  }

  /** The engine with this name, for a phone call that arrived on it (OpenAI decides that by the kind of call). */
  named(name: string): VoiceEngine | null {
    return this.engines[name] ?? null;
  }

  private of(sessionId: string) {
    return this.bySession.get(sessionId) ?? this.engines[this.fallback]!;
  }

  /** Takes a phone call with a given engine, whatever the clinic chose: the call came in on it. */
  async acceptWith(engine: VoiceEngine, sessionId: string, clinic: ClinicConfig, now: Date, opening?: string) {
    this.bySession.set(sessionId, engine);
    await (opening === undefined ? engine.accept(sessionId, clinic, now) : engine.accept(sessionId, clinic, now, opening));
  }

  async accept(sessionId: string, clinic: ClinicConfig, now: Date, opening?: string) {
    return this.acceptWith(this.engineFor(clinic), sessionId, clinic, now, opening);
  }

  async startBrowserCall(clinic: ClinicConfig, sdpOffer: string, now: Date) {
    const engine = this.engineFor(clinic);
    const started = await engine.startBrowserCall(clinic, sdpOffer, now);
    this.bySession.set(started.sessionId, engine);
    return started;
  }

  reject(sessionId: string, sipStatus: number) { return this.of(sessionId).reject(sessionId, sipStatus); }
  attach(sessionId: string): Sideband { return this.of(sessionId).attach(sessionId); }
  transfer(sessionId: string, targetUri: string) { return this.of(sessionId).transfer(sessionId, targetUri); }
  hangup(sessionId: string) { return this.of(sessionId).hangup(sessionId); }

  release(sessionId: string) {
    this.of(sessionId).release?.(sessionId);
    this.bySession.delete(sessionId);
  }
}
