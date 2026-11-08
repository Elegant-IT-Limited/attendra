// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { VoiceEngineName } from './call-costs';

/**
 * Vapi as a location's backup voice engine (batch 6). Attendra's own engine is every clinic's default; a location is on
 * Vapi only when the operator switches it (provisioning `PUT clinics/:id/voice-engine {engine: 'vapi'}`). Vapi then hears
 * the caller, runs its model and speaks, and every decision is still ours: its function tools are our tools API
 * (apps/voice/src/vapi.ts), and its prompt is the same tools voice prompt, built from the clinic's settings.
 */

/** The OpenAI engines Attendra runs itself. */
export const OPENAI_ENGINES = ['gpt-live', 'gpt-realtime'] as const;
export type OpenAiEngine = (typeof OPENAI_ENGINES)[number];

/** Vapi's own voices that speak Spanish as well as English (voice version 2, automatic language): docs.vapi.ai/providers/voice/vapi-voices. */
export const VAPI_OWN_VOICES = ['Clara', 'Elliot', 'Emma', 'Godfrey', 'Kai', 'Layla', 'Naina', 'Neil', 'Nico', 'Sagar', 'Savannah', 'Sid'] as const;
/** ElevenLabs models Vapi offers; flash v2.5 is the fastest that speaks Spanish. */
export const ELEVENLABS_MODELS = ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'] as const;
/** Cartesia models Vapi offers (sonic-3 and later speak Spanish). */
export const CARTESIA_MODELS = ['sonic-3.5', 'sonic-3.6', 'sonic-3'] as const;

const voiceId = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_\-.]+$/, 'a voice id is letters, digits, dots, dashes and underscores');

/**
 * A location's voice on Vapi, when it is not the default (VAPI_DEFAULTS.voice in packages/voice-engine/src/vapi.ts). All
 * three are billed through Vapi: no key of ours at ElevenLabs or Cartesia. A Cartesia voice has no preset names, so its
 * id is copied from Vapi's Voice Library.
 */
export const VapiVoiceChoice = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('vapi'), voiceId: z.enum(VAPI_OWN_VOICES) }),
  z.object({ provider: z.literal('11labs'), voiceId, model: z.enum(ELEVENLABS_MODELS).optional() }),
  z.object({ provider: z.literal('cartesia'), voiceId, model: z.enum(CARTESIA_MODELS).optional() }),
]);
export type VapiVoiceChoice = z.infer<typeof VapiVoiceChoice>;

/**
 * What the engine keeps about a location's Vapi resources, in its settings: ids only, set by provisioning (never by
 * Settings, which keeps it as it is). The per-location secret Vapi sends with each request is not here: it is in
 * vapi_secrets (migration 0056), encrypted, with its hash for checking.
 */
export const VapiLink = z.object({
  assistantId: z.string().max(100).optional(),
  phoneNumberId: z.string().max(100).optional(),
  /** Where Twilio's Vapi trunk sends this location's calls (origination), for the hosting layer. */
  sipUri: z.string().max(300).optional(),
  /** When the assistant was last created or updated from the settings. */
  updatedAt: z.iso.datetime().optional(),
  /** A hash of what was last sent to Vapi: the settings changed since when it no longer matches. */
  syncedHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /**
   * The engine of ours that answers a call reaching our own SIP path while the location is on Vapi (Vapi full, or down:
   * Twilio's fallback), and the one to switch back to: the location's engine when it was switched to Vapi.
   */
  overflowEngine: z.enum(OPENAI_ENGINES).optional(),
  /** The location's own voice on Vapi; absent, the default. */
  voice: VapiVoiceChoice.optional(),
});
export type VapiLink = z.infer<typeof VapiLink>;

/**
 * The engine of ours a clinic's call uses when it reaches our own SIP path or a browser test call: its own choice, or,
 * while it is on Vapi, the engine it had before (absent: the deployment's default).
 */
export function openAiEngineOf(clinic: { voiceEngine?: VoiceEngineName; vapi?: { overflowEngine?: OpenAiEngine } }): OpenAiEngine | undefined {
  return clinic.voiceEngine === 'vapi' ? clinic.vapi?.overflowEngine : clinic.voiceEngine;
}

/**
 * Calls live at the same moment across every Vapi location (Vapi's limit is per subscription, not per clinic): the free
 * tier's 4 unless VAPI_MAX_CONCURRENCY says otherwise (Core package 10, +1 per line bought).
 */
export const VAPI_FREE_CONCURRENCY = 4;
/** The share of the limit at which the people who run Attendra are told (Slack), once a day. */
export const VAPI_ALERT_SHARE = 0.7;
/** How many live Vapi calls make the alert: 70% of the limit, rounded up (3 of 4, 7 of 10). */
export const vapiAlertAt = (limit: number) => Math.max(1, Math.ceil(limit * VAPI_ALERT_SHARE));
/** A Vapi call with no end heard after this long is no longer counted as live (its end-of-call report never came). */
export const VAPI_CALL_STALE_MS = 2 * 3_600_000;

/**
 * The test clinics (the bake-off's, the local demo's: made-up data) a Vapi assistant may reach with the deployment-wide
 * secret (VAPI_SERVER_SECRET). Every real location has its own secret.
 */
export const isVapiTestClinic = (clinicId: string) => clinicId.startsWith('clinic_bakeoff') || clinicId.startsWith('clinic_demo');
