// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The emergency guardrail. It runs on every caller transcript fragment, before and
 * independently of the model, and a clinic cannot turn it off.
 *
 * It is deliberately a phrase list, not a classifier. A missed emergency is the one
 * failure this product cannot have, so the list errs toward false positives: telling
 * a caller with a mild cough to call 911 costs a moment of confusion, missing chest
 * pain costs far more. The patterns are reviewed by a clinician before any release
 * (docs/safety.md) and every one has a test.
 */

export type EmergencyKind = 'cardiac' | 'breathing' | 'stroke' | 'bleeding' | 'unresponsive' | 'self_harm' | 'overdose' | 'allergic' | 'general';

const PATTERNS: [EmergencyKind, RegExp][] = [
  ['cardiac', /\b(chest (pain|pressure|tightness|hurts?)|heart attack|pain (in|down) my (left )?arm)\b/],
  ['breathing', /\b(can'?t|cannot|can not|hard to|trouble|struggling to) breathe?\b|\bnot breathing\b|\bshort(ness)? of breath\b|\bchoking\b/],
  ['stroke', /\b(stroke|face (is )?droop(ing)?|slurr(ed|ing) (speech|words)|can'?t (move|feel) (my )?(arm|leg|face))\b/],
  ['bleeding', /\b(won'?t stop bleeding|bleeding (a lot|heavily|badly)|lots of blood|coughing (up )?blood|vomiting blood)\b/],
  ['unresponsive', /\b(unconscious|passed out|not (waking|responding)|unresponsive|seizure|fitting)\b/],
  ['self_harm', /\b(kill (myself|me)|end (it all|my life)|suicid(e|al)|hurt myself|(don'?t|do not) (really |even )?want to (live|be alive|be here)( anymore)?|better off dead)\b/],
  ['overdose', /\b(overdos(e|ed|ing)|took too (many|much)|swallowed (a bottle|the whole))\b/],
  ['allergic', /\b(throat (is )?(closing|swelling)|anaphyla(xis|ctic)|tongue (is )?swelling)\b/],
  ['general', /\b(emergency|call (an )?ambulance|911)\b/],
];

export interface EmergencyMatch { kind: EmergencyKind; phrase: string }

/**
 * Checks the recent caller text. Pass a rolling window, not just the latest delta:
 * transcripts arrive in fragments, and "chest" and "pain" can land in different ones.
 */
export function detectEmergency(recentCallerText: string): EmergencyMatch | null {
  return detectEmergencies(recentCallerText)[0] ?? null;
}

/** Every kind present in the text, most specific first, so a second emergency in the same window is not hidden by the first. */
export function detectEmergencies(recentCallerText: string): EmergencyMatch[] {
  const text = recentCallerText.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
  const found: EmergencyMatch[] = [];
  for (const [kind, re] of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    // "it's not an emergency" is the one negation we honour, and only for the
    // generic word: "no chest pain" style negations are too easy to mishear
    if (kind === 'general' && NOT_AN_EMERGENCY.test(text)) continue;
    found.push({ kind, phrase: m[0] });
  }
  return found;
}

const NOT_AN_EMERGENCY = /\b(not an? emergency|isn'?t an emergency|no emergency|not urgent)\b/;

/** Kinds serious enough to ring the on-call line (when the clinic enabled it). The word "emergency" alone is not. */
export const TRANSFER_KINDS = new Set<EmergencyKind>(['cardiac', 'breathing', 'stroke', 'bleeding', 'unresponsive', 'self_harm', 'overdose', 'allergic']);

/**
 * Fixed text, owned by the clinic and reviewed at onboarding. Sent as a session
 * instruction, so the model says it in its own voice but may not soften or replace it.
 */
export const EMERGENCY_INSTRUCTION =
  'The caller may be describing a medical emergency. Stop the current task now. Say, calmly and clearly: ' +
  '"If this is a medical emergency, please hang up and call 911 right away." ' +
  'Do not give medical advice, do not ask about symptoms, and do not continue booking. ' +
  'If the caller says they are safe and it is not an emergency, you may continue.';

export const SELF_HARM_INSTRUCTION =
  'The caller may be at risk of harming themselves. Stop the current task. Say, calmly and kindly: ' +
  '"I\'m really glad you called. If you are in danger right now, please call 911. You can also call or text 988 ' +
  'to reach the Suicide and Crisis Lifeline, any time, day or night." Stay warm and brief. Do not give medical advice.';
