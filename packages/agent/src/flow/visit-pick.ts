// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, normalise, type Provider, saysClockTime, saysVisitDay, soundsLike } from '@attendra/core';
import type { CallState } from '../call-state';

/** One of the pet's visits still to come, as the scheduler lists them. */
export interface UpcomingVisit { id: string; start: Date; providerId?: string }

/**
 * Which of the pet's visits the caller means, when it has more than one to come (a test call, 2026-11-16: right after
 * booking a second visit the caller asked to move "it" to another day, and the visit the clinic had booked earlier was moved,
 * then the wrong one cancelled). In this order:
 * 1. the visit the caller's own words name last, by its time or, when no other visit shares it, its day ("the 2:00
 *    one", "315", "the Thursday one") or its vet ("the booking with Dr. Ruiz"), since the latest visit booked on this
 *    call when there is one;
 * 2. "it", with none named: the visit booked or moved on this call. Never when the caller's words name a vet, a day or
 *    another pet that does not pick one visit: a named vet, day or pet always wins over "the one just booked" (T3, a
 *    tester's call 2026-11-24: "cancel the booking with Dr. <first name>" was turned into the visit just booked, with another vet);
 * 3. the visit the assistant itself put forward to move ("would you rather move that one?").
 * Null when none of these says: the caller is asked which, naming each.
 */
export function visitMeant(
  state: CallState, upcoming: readonly UpcomingVisit[], timeZone: string, now: Date, providers: readonly Pick<Provider, 'id' | 'name' | 'kind'>[] = [],
): { id: string; why: 'named' | 'booked_on_call' | 'put_forward' } | null {
  const ids = new Set(upcoming.map((a) => a.id));
  const from = state.memory.visit && ids.has(state.memory.visit.appointmentId) ? state.memory.visitAtTurn ?? 0 : 0;
  // the caller named something that tells the visits apart, without picking exactly one: "it" is not the one just booked
  let namedSomething = false;
  for (let i = state.turns.length - 1; i >= from; i--) {
    const turn = state.turns[i]!;
    if (turn.speaker !== 'caller') continue;
    const named = namedIn(turn.text, upcoming, timeZone, now, providers);
    if (named.id) return { id: named.id, why: 'named' };
    if (named.something || otherPetNamed(turn.text, state)) namedSomething = true;
  }
  if (namedSomething) return null;
  if (state.memory.visit && ids.has(state.memory.visit.appointmentId)) return { id: state.memory.visit.appointmentId, why: 'booked_on_call' };
  if (state.visitPutForward && ids.has(state.visitPutForward)) return { id: state.visitPutForward, why: 'put_forward' };
  return null;
}

/**
 * The one visit these words name: by its time, by its day when it is the only visit that day, or by its vet when it is
 * the only visit with them. `something` when the words name a time, a day or a vet that fits more than one visit.
 */
function namedIn(text: string, upcoming: readonly UpcomingVisit[], timeZone: string, now: Date, providers: readonly Pick<Provider, 'id' | 'name' | 'kind'>[]): { id: string | null; something: boolean } {
  const byTime = upcoming.filter((a) => saysClockTime(text, a.start, timeZone));
  if (byTime.length === 1) return { id: byTime[0]!.id, something: true };
  if (byTime.length > 1) return { id: null, something: true };
  const byDay = upcoming.filter((a) => saysVisitDay(text, a.start, timeZone, now));
  const vets = vetsNamedIn(text, providers);
  const byVet = vets.size ? upcoming.filter((a) => a.providerId !== undefined && vets.has(a.providerId)) : [];
  // a day and a vet together narrow it to the visit that has both
  const both = byDay.filter((a) => byVet.includes(a));
  if (both.length === 1) return { id: both[0]!.id, something: true };
  if (byDay.length === 1 && !vets.size) return { id: byDay[0]!.id, something: true };
  if (byVet.length === 1 && !byDay.length) return { id: byVet[0]!.id, something: true };
  return { id: null, something: byDay.length > 0 || vets.size > 0 };
}

const TITLE = /^(?:dr|dra|doctor|doctora|doc)$/;
/**
 * The vets these words name: a part of the vet's name after a title ("Dr. Elena", "la doctora Ruiz"), by sound, or a
 * whole first or last name of four letters or more said on its own ("the one with Ruiz").
 */
export function vetsNamedIn(text: string, providers: readonly Pick<Provider, 'id' | 'name' | 'kind'>[]): Set<string> {
  const words = normalise(text).replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(' ').filter(Boolean);
  const out = new Set<string>();
  for (const p of providers) {
    if (p.kind === 'room') continue;
    const parts = normalise(p.name).replace(/[^\p{L}' ]+/gu, ' ').split(' ').filter((w) => w.length > 1 && !TITLE.test(w));
    words.forEach((w, i) => {
      const titled = i > 0 && TITLE.test(words[i - 1]!);
      if (parts.some((part) => (titled && soundsLike(w, part)) || (part.length >= 4 && w === part))) out.add(p.id);
    });
  }
  return out;
}

/** The caller named one of the household's other pets: the visit just booked for this one is not what they mean. */
function otherPetNamed(text: string, state: CallState): boolean {
  const current = state.verifiedPatient?.firstName ? normalise(state.verifiedPatient.firstName) : null;
  const t = ` ${normalise(text).replace(/[^\p{L}\p{N}' ]+/gu, ' ')} `;
  return state.memory.pets.some((p) => { const n = normalise(p); return n !== current && n.length > 1 && t.includes(` ${n} `); });
}

/** The question when the call cannot tell which visit the caller means: each one named, in the caller's language. */
export function whichVisitLine(lang: Language, change: 'move' | 'cancel', pet: string | null, visits: string[]): string {
  const list = (words: string[], and: string) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} ${and} ${words.at(-1)}`);
  if (lang === 'es') {
    return `${pet ?? 'Su mascota'} tiene ${visits.length} citas: ${list(visits, 'y')}. ¿Cuál quiere ${change === 'move' ? 'cambiar' : 'cancelar'}?`;
  }
  return `${pet ?? 'Your pet'} has ${visits.length} visits coming up: ${list(visits, 'and')}. Which one would you like to ${change === 'move' ? 'move' : 'cancel'}?`;
}
