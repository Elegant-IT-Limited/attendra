// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, localName, normalise } from '@attendra/core';
import type { CallState } from '../call-state';

/**
 * The lookup the caller's last words ask for, started before the voice decides (batch 1a, round 2): the moment their
 * words are in, the times are looked up and handed to the voice with them, so it answers in one reply instead of a
 * tool call and a second reply. Only when the call makes it plain, and never a guess:
 * - the pet (or patient) is found, and nothing waits for a yes (a read-back is answered, not looked up);
 * - the visit is known: from an earlier lookup on this call, or named by the caller ("a vaccine appointment");
 * - the caller's last turn asks about a day or a time ("is 4 free?", "what about Thursday?", "the earliest").
 * The day, time and vet come from the call memory, as for any find_slots call.
 */
export interface Speculation { name: 'find_slots'; args: Record<string, unknown> }

/** Words that ask about a day or a time, in English and Spanish (after `normalise`). */
const ASKS_TIME = /\b(free|available|availability|open(ing)?s?|earliest|soonest|first (time|one|available)|any ?time|when can|what (times|do you have)|anything (on|for|at)|how about|what about|tomorrow|today|tonight|next (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|noon|\d{1,2}(:\d\d)?\s*(am|pm|a m|p m)|o'?clock|libre|disponible|hay (algo|lugar|espacio|cita)|manana|hoy|lunes|martes|miercoles|jueves|viernes|sabado|domingo|por la (manana|tarde)|temprano|lo antes posible|la proxima semana)\b/;

/** A visit the caller named in their words: a whole word of the visit's name (four letters or more), in either language. */
function namedVisit(clinic: ClinicConfig, said: string): string | null {
  const words = new Set(said.split(/[^\p{L}]+/u).filter((w) => w.length >= 4));
  const hits = clinic.visitTypes.filter((v) => (['en', 'es'] as const).some((l) => normalise(localName(v, l)).split(/[^\p{L}]+/u).some((w) => w.length >= 4 && words.has(w))));
  return hits.length === 1 ? hits[0]!.id : null;
}

export function speculativeLookup(state: CallState, clinic: ClinicConfig): Speculation | null {
  if (!state.verifiedPatient || state.pending || state.emergencyLocked || state.ending) return null;
  const last = state.turns.at(-1);
  if (!last || last.speaker !== 'caller') return null;
  const said = normalise(last.text);
  if (!ASKS_TIME.test(said)) return null;
  const known = state.memory.get('visitType');
  const visit = (known && clinic.visitTypes.some((v) => v.id === known) ? known : null) ?? namedVisit(clinic, said);
  if (!visit) return null;
  // the part of the day they asked for goes with it: "an afternoon time?" looked up as any time found only mornings
  const part = /\b(afternoon|tarde|evening|after lunch|despues de comer)\b/.test(said) ? 'afternoon' : /\b(morning|por la manana|en la manana|temprano)\b/.test(said) ? 'morning' : 'any';
  return { name: 'find_slots', args: { visit_type_id: visit, provider_id: null, from_date: null, part_of_day: part } };
}
