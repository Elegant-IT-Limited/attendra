// SPDX-License-Identifier: AGPL-3.0-only
import { LANGUAGES, normalise, PACKS } from './locales';

/**
 * Did the caller clearly agree? Used by the agent before any write, on the caller's
 * own words since the read-back, never on the model's summary of them. Anything
 * hedged or mixed ("yes, actually no", "I think so?", "sí, pero espere", "ji, pore")
 * is not a yes.
 *
 * Every language's yes counts, and every language's hedge blocks: callers switch
 * languages mid-sentence, and a hedge in any of them means wait.
 */
export function isClearYes(callerTextSinceReadback: string): boolean {
  const t = normalise(callerTextSinceReadback).trim();
  if (!t) return false;
  const yes = LANGUAGES.some((l) => PACKS[l].yes.test(t));
  const hedge = LANGUAGES.some((l) => PACKS[l].hedge.test(t));
  return yes && !hedge;
}
