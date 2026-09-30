// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, LANGUAGES, normalise, PACKS } from './locales';

/**
 * The emergency guardrail. It runs on every caller transcript fragment, before and
 * independently of the model, and a clinic cannot turn it off.
 *
 * It is deliberately a phrase list, not a classifier. A missed emergency is the one
 * failure this product cannot have, so the list errs toward false positives: telling
 * a caller with a mild cough to call 911 costs a moment of confusion, missing chest
 * pain costs far more. The patterns live in the language packs, are reviewed by a
 * clinician before any release (docs/safety.md), and every one has a test.
 *
 * Every pack's phrases are checked on every call, whatever languages the clinic has
 * switched on: a caller does not choose their language by the clinic's settings.
 */

export type EmergencyKind = 'cardiac' | 'breathing' | 'stroke' | 'bleeding' | 'unresponsive' | 'self_harm' | 'overdose' | 'allergic' | 'general';

export interface EmergencyMatch { kind: EmergencyKind; phrase: string; language: Language }

/**
 * Checks the recent caller text. Pass a rolling window, not just the latest delta:
 * transcripts arrive in fragments, and "chest" and "pain" can land in different ones.
 */
export function detectEmergency(recentCallerText: string): EmergencyMatch | null {
  return detectEmergencies(recentCallerText)[0] ?? null;
}

/** Every kind present in the text, most specific first, so a second emergency in the same window is not hidden by the first. */
export function detectEmergencies(recentCallerText: string): EmergencyMatch[] {
  const text = normalise(recentCallerText);
  const found: EmergencyMatch[] = [];
  const seen = new Set<EmergencyKind>();
  for (const language of LANGUAGES) {
    const pack = PACKS[language];
    for (const [kind, re] of pack.emergencyPhrases) {
      if (seen.has(kind)) continue;
      const m = text.match(re);
      if (!m) continue;
      // "it's not an emergency" is the one negation we honour, and only for the
      // generic word: "no chest pain" style negations are too easy to mishear
      if (kind === 'general' && LANGUAGES.some((l) => PACKS[l].notAnEmergency.test(text))) continue;
      seen.add(kind);
      found.push({ kind, phrase: m[0], language });
    }
  }
  // the generic word last, so a specific kind leads
  return [...found.filter((f) => f.kind !== 'general'), ...found.filter((f) => f.kind === 'general')];
}

/** Kinds serious enough to ring the on-call line (when the clinic enabled it). The word "emergency" alone is not. */
export const TRANSFER_KINDS = new Set<EmergencyKind>(['cardiac', 'breathing', 'stroke', 'bleeding', 'unresponsive', 'self_harm', 'overdose', 'allergic']);

/**
 * Fixed text, owned by the clinic and reviewed at onboarding. Sent as a session
 * instruction, so the model says it in its own voice but may not soften or replace it.
 * These are the English, United States versions; calls use the language pack's.
 */
export const EMERGENCY_INSTRUCTION = PACKS.en.emergencyScript('911');
export const SELF_HARM_INSTRUCTION = PACKS.en.selfHarmScript('911', '988');
