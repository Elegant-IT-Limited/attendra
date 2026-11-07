// SPDX-License-Identifier: AGPL-3.0-only

/** The voice engines a call can run on. */
export const VOICE_ENGINES = ['gpt-live', 'gpt-realtime', 'vapi'] as const;
export type VoiceEngineName = (typeof VOICE_ENGINES)[number];

/** How a call's turns are answered: one hand-off per turn to the planner, or the voice calling the tools API itself. */
export const VOICE_FLOWS = ['planner', 'tools'] as const;
export type VoiceFlow = (typeof VOICE_FLOWS)[number];

/** Tokens one model used on a call. `cached` is the part of `input` the provider's prompt cache already held. */
export interface ModelTokens { input: number; cached: number; output: number }

/**
 * The one rates table every call's cost is worked out from (COST-1), in US dollars. These are list prices as we know
 * them, for the margin per clinic in the back office, never a bill: change a price here, bump `version`, and every call
 * closed after carries the new version on its row. A model or engine missing here costs 0 and is logged by the caller.
 */
export const CALL_RATES = {
  version: '2026-11-07',
  /**
   * Voice engine, per minute of the call: OpenAI bills GPT-Live by the minute, and Vapi reports its own charge. gpt-realtime
   * is billed by its tokens (below, `<model>:audio` and `<model>:text`); the minute rate is only for a call without them.
   */
  voicePerMinute: { 'gpt-live': 0.05, 'gpt-realtime': 0.085, vapi: 0.11 } satisfies Record<VoiceEngineName, number>,
  /** Text models, per million tokens. Priority processing ("fast") is charged at twice these. */
  modelsPerMTok: {
    'gpt-6-luna': { input: 0.10, cached: 0.01, output: 0.50 },
    'gpt-6-sol': { input: 1.25, cached: 0.125, output: 10 },
    // gpt-realtime, per modality (OpenAI's price list, 2026-11-07): what path A's voice actually costs
    'gpt-realtime-2.1:audio': { input: 32, cached: 0.40, output: 64 },
    'gpt-realtime-2.1:text': { input: 4, cached: 0.40, output: 24 },
    'gpt-realtime-2.1-mini:audio': { input: 10, cached: 0.30, output: 20 },
    'gpt-realtime-2.1-mini:text': { input: 0.60, cached: 0.06, output: 2.40 },
    // the caller's words transcribed on gpt-realtime (about $0.006 a minute)
    'gpt-4o-transcribe': { input: 2.50, cached: 2.50, output: 10 },
    'gpt-4o-mini-transcribe': { input: 1.25, cached: 1.25, output: 5 },
  } as Record<string, { input: number; cached: number; output: number }>,
  /** One text segment, carrier fees included (Twilio US). */
  textEach: 0.0123,
  /** The phone line, per minute: Twilio SIP origination. Browser test calls have none. */
  phonePerMinute: 0.0034,
} as const;

export interface CallCostInput {
  engine: VoiceEngineName;
  channel: 'phone' | 'web';
  voiceSeconds: number | null;
  /** Tokens per model, and whether priority processing was asked for. */
  models: Record<string, ModelTokens>;
  fastTier?: boolean;
  texts: number;
  /** What the engine itself charged for the call (Vapi reports it), when known: used instead of minutes at the list rate. */
  engineUsd?: number;
}

export interface CallCost {
  engine: VoiceEngineName; voiceSeconds: number | null;
  voiceUsd: number; modelTokens: Record<string, ModelTokens>; modelUsd: number;
  texts: number; textsUsd: number; telephonyUsd: number; totalUsd: number;
  ratesVersion: string;
  /** Models used that the rates table has no price for: counted as 0 here, worth a log line. */
  unpriced: string[];
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** What one call cost, from the rates table. Every part rounds to a millionth of a dollar. */
export function callCost(c: CallCostInput, rates = CALL_RATES): CallCost {
  const minutes = Math.max(0, c.voiceSeconds ?? 0) / 60;
  // gpt-realtime with its tokens counted: the voice is in the model cost, not the minute rate (counted once)
  const byTokens = c.engine === 'gpt-realtime' && Object.keys(c.models).some((m) => m.endsWith(':audio'));
  const voiceUsd = c.engineUsd !== undefined && c.engineUsd >= 0 ? c.engineUsd : byTokens ? 0 : minutes * rates.voicePerMinute[c.engine];
  const unpriced: string[] = [];
  let modelUsd = 0;
  for (const [model, t] of Object.entries(c.models)) {
    const price = rates.modelsPerMTok[model];
    if (!price) { unpriced.push(model); continue; }
    const fresh = Math.max(0, t.input - t.cached);
    modelUsd += ((fresh * price.input + t.cached * price.cached + t.output * price.output) / 1e6) * (c.fastTier ? 2 : 1);
  }
  const textsUsd = c.texts * rates.textEach;
  const telephonyUsd = c.channel === 'phone' ? minutes * rates.phonePerMinute : 0;
  return {
    engine: c.engine, voiceSeconds: c.voiceSeconds, voiceUsd: round6(voiceUsd), modelTokens: c.models, modelUsd: round6(modelUsd),
    texts: c.texts, textsUsd: round6(textsUsd), telephonyUsd: round6(telephonyUsd),
    totalUsd: round6(voiceUsd + modelUsd + textsUsd + telephonyUsd), ratesVersion: rates.version, unpriced,
  };
}

/** Adds one request's tokens to a call's running count per model. */
export function addTokens(into: Record<string, ModelTokens>, model: string, t: Partial<ModelTokens>) {
  const now = into[model] ?? { input: 0, cached: 0, output: 0 };
  into[model] = { input: now.input + (t.input ?? 0), cached: now.cached + (t.cached ?? 0), output: now.output + (t.output ?? 0) };
}
