// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Did the caller clearly agree? Used by the agent before any write, on the caller's
 * own words since the read-back, never on the model's summary of them. Anything
 * hedged or mixed ("yes, actually no", "I think so?") is not a yes.
 */
const YES = /\b(yes|yeah|yep|yup|correct|that'?s (right|correct|fine|good|perfect)|sounds good|perfect|please do|go ahead|book it|do it|sure)\b/;
const NO_OR_HEDGE = /\b(no|nope|not|don'?t|wait|actually|hold on|hmm|maybe|instead|rather|change|different|other)\b|\?/;

export function isClearYes(callerTextSinceReadback: string): boolean {
  const t = callerTextSinceReadback.toLowerCase().replace(/[’]/g, "'").trim();
  if (!t) return false;
  return YES.test(t) && !NO_OR_HEDGE.test(t);
}
