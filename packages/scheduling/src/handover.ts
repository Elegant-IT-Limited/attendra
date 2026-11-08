// SPDX-License-Identifier: AGPL-3.0-only
import type { BusyInterval, ClinicConfig } from '@attendra/core';
import { type SlotProblem, slotProblem } from './rules';

/** One of the leaving vet's visits still to come: ids, type and times only. */
export interface HandoverVisit { appointmentId: string; visitTypeId: string; start: Date; end: Date }

/** Why a visit cannot go to another vet: the booking rule's own reason (the vet does not do it, is away, is busy then) or nobody to take it. */
export type HandoverProblem = SlotProblem | 'no_vet';

export interface HandoverPlan {
  /** Each visit that can move, and to whom: the same day and time, with another vet. */
  moves: (HandoverVisit & { toProviderId: string })[];
  /** Each visit nothing can take, and why: listed for the team to move or cancel by hand, never dropped. */
  stuck: (HandoverVisit & { reason: HandoverProblem })[];
  /** The vets who could take visits, with how many each could take on their own (most first). */
  candidates: { providerId: string; canTake: number }[];
}

/**
 * Who takes a leaving vet's visits (note 32, SCH-3). Each visit keeps its day and time and
 * goes to a vet who does that visit type and works then: the booking rules decide
 * (slotProblem, the desk's own check, without Override), so a move is never a clash, never
 * outside a vet's hours and never on their day off. With `toProviderId`, every visit is
 * offered to that one vet; without it, each visit goes to the vet who can take the most of
 * them and is free then, the next one if not. Visits planned onto a vet in this same
 * handover count as busy for the next. What no vet can take is listed with the reason.
 */
export function planHandover(
  clinic: ClinicConfig,
  fromProviderId: string,
  visits: HandoverVisit[],
  busy: BusyInterval[],
  now: Date,
  opts: { toProviderId?: string | null } = {},
): HandoverPlan {
  const leaving = clinic.providers.find((p) => p.id === fromProviderId);
  // a vet's visits go to another vet, a room's to another room; the stand-in a new clinic starts with takes none
  const pool = clinic.providers.filter((p) => p.id !== fromProviderId && !p.placeholder && p.kind === (leaving?.kind ?? 'person'));
  const asked = opts.toProviderId ? pool.filter((p) => p.id === opts.toProviderId) : pool;
  const sorted = [...visits].sort((a, b) => a.start.getTime() - b.start.getTime());
  const fits = (providerId: string, v: HandoverVisit, taken: BusyInterval[]) =>
    slotProblem(clinic, taken, { providerId, visitTypeId: v.visitTypeId, start: v.start }, now);
  const candidates = asked.map((p) => ({ providerId: p.id, canTake: sorted.filter((v) => !fits(p.id, v, busy)).length }))
    .sort((a, b) => b.canTake - a.canTake);
  const order = candidates.map((c) => c.providerId);
  const planned: BusyInterval[] = [];
  const moves: HandoverPlan['moves'] = [];
  const stuck: HandoverPlan['stuck'] = [];
  for (const v of sorted) {
    const taken = [...busy, ...planned];
    const to = order.find((id) => !fits(id, v, taken));
    if (to) {
      moves.push({ ...v, toProviderId: to });
      planned.push({ providerId: to, start: v.start, end: v.end, visitTypeId: v.visitTypeId });
      continue;
    }
    // the reason from the vet who does this kind of visit and could take the most; nobody does it at all: not offered
    const offering = order.find((id) => clinic.providers.find((p) => p.id === id)?.visitTypeIds.includes(v.visitTypeId));
    stuck.push({ ...v, reason: !order.length ? 'no_vet' : offering ? fits(offering, v, taken) ?? 'taken' : 'not_offered' });
  }
  return { moves, stuck, candidates };
}
