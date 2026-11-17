// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, saysClockTime, saysVisitDay } from '@attendra/core';
import type { CallState } from '../call-state';

/** One of the pet's visits still to come, as the scheduler lists them. */
export interface UpcomingVisit { id: string; start: Date }

/**
 * Which of the pet's visits the caller means, when it has more than one to come (a test call, 2026-11-16: right after
 * booking a second visit the caller asked to move "it" to another day, and the visit the clinic had booked earlier was moved,
 * then the wrong one cancelled). In this order:
 * 1. the visit the caller's own words name last, by its time or, when no other visit shares it, its day ("the 2:00
 *    one", "315", "the Thursday one"), since the latest visit booked on this call when there is one;
 * 2. "it", with none named: the visit booked or moved on this call;
 * 3. the visit the assistant itself put forward to move ("would you rather move that one?").
 * Null when none of these says: the caller is asked which, naming each.
 */
export function visitMeant(state: CallState, upcoming: readonly UpcomingVisit[], timeZone: string, now: Date): { id: string; why: 'named' | 'booked_on_call' | 'put_forward' } | null {
  const ids = new Set(upcoming.map((a) => a.id));
  const from = state.memory.visit && ids.has(state.memory.visit.appointmentId) ? state.memory.visitAtTurn ?? 0 : 0;
  for (let i = state.turns.length - 1; i >= from; i--) {
    const turn = state.turns[i]!;
    if (turn.speaker !== 'caller') continue;
    const named = namedIn(turn.text, upcoming, timeZone, now);
    if (named) return { id: named, why: 'named' };
  }
  if (state.memory.visit && ids.has(state.memory.visit.appointmentId)) return { id: state.memory.visit.appointmentId, why: 'booked_on_call' };
  if (state.visitPutForward && ids.has(state.visitPutForward)) return { id: state.visitPutForward, why: 'put_forward' };
  return null;
}

/** The one visit these words name: by its time, or else by its day when it is the only visit that day. */
function namedIn(text: string, upcoming: readonly UpcomingVisit[], timeZone: string, now: Date): string | null {
  const byTime = upcoming.filter((a) => saysClockTime(text, a.start, timeZone));
  if (byTime.length === 1) return byTime[0]!.id;
  if (byTime.length > 1) return null;
  const byDay = upcoming.filter((a) => saysVisitDay(text, a.start, timeZone, now));
  return byDay.length === 1 ? byDay[0]!.id : null;
}

/** The question when the call cannot tell which visit the caller means: each one named, in the caller's language. */
export function whichVisitLine(lang: Language, change: 'move' | 'cancel', pet: string | null, visits: string[]): string {
  const list = (words: string[], and: string) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} ${and} ${words.at(-1)}`);
  if (lang === 'es') {
    return `${pet ?? 'Su mascota'} tiene ${visits.length} citas: ${list(visits, 'y')}. ¿Cuál quiere ${change === 'move' ? 'cambiar' : 'cancelar'}?`;
  }
  return `${pet ?? 'Your pet'} has ${visits.length} visits coming up: ${list(visits, 'and')}. Which one would you like to ${change === 'move' ? 'move' : 'cancel'}?`;
}
