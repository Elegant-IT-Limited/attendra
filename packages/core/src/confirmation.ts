// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, LANGUAGES, normalise, PACKS } from './locales';

/**
 * Did the caller clearly agree? Used by the agent before any write, on the caller's
 * own words since the read-back, never on the model's summary of them. Anything
 * hedged or mixed ("yes, actually no", "I think so?", "sí, pero espere", "ji, pore")
 * is not a yes.
 *
 * A yes counts only in the languages the clinic offers: a word that means yes in
 * another language ("ha", "confirm") is ordinary English at an English clinic. Short,
 * ambiguous words count only as the whole answer. A hedge in any language blocks it,
 * because a caller who switches languages to say "wait" still means wait.
 */
export function isClearYes(callerTextSinceReadback: string, languages: readonly Language[]): boolean {
  const t = normalise(callerTextSinceReadback).trim();
  if (!t) return false;
  const whole = t.replace(/[.,!¡]+/g, ' ').replace(/\s+/g, ' ').trim();
  const yes = languages.some((l) => PACKS[l].yes.test(t) || PACKS[l].yesAlone.test(whole));
  const hedge = LANGUAGES.some((l) => PACKS[l].hedge.test(t));
  return yes && !hedge;
}
