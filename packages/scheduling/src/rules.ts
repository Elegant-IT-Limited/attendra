// SPDX-License-Identifier: AGPL-3.0-only
import { awayOn, awayWindows, type BookingActor, bookableProviders, bookableWindows, bookingPolicy, type BusyInterval, clashes, type ClinicConfig, findSlots, localDateOf, localParts, policyProblem, seesAge, type Slot, specialDayOf } from '@attendra/core';

/** Why a time cannot be booked, in the words the API and the dashboard use. */
export type SlotProblem =
  | 'unknown_provider'
  | 'unknown_visit_type'
  | 'not_offered' // the provider does not do this visit type
  | 'holiday' // a holiday, or a special day the clinic is closed
  | 'away' // the provider is away then, all day or part of it
  | 'closed' // outside the provider's hours, or not on the clinic's start-time grid
  | 'past'
  | 'too_soon' // starts within the actor's lead time (core bookingPolicy): for the desk a walk-in that soon is its Override
  | 'notice' // the assistant only: inside the visit type's notice
  | 'too_far_ahead' // the assistant only: after the visit type's furthest date
  | 'taken';

type Clinic = Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone' | 'providers' | 'visitTypes' | 'specialDays' | 'booking'>;

export interface OpenSlotQuery {
  visitTypeId: string;
  providerId?: string | null;
  from: string; // local YYYY-MM-DD
  days: number;
  partOfDay?: 'morning' | 'afternoon' | 'any';
  now: Date;
  /** Who books (core bookingPolicy): the desk for staff, the assistant for anything that offers times to a caller (MCP). */
  actor: BookingActor;
  limit?: number;
  /** Who the visit is for: with no provider picked, only providers who see their age, and take new patients if they are new, as on calls. */
  patient?: { age: number; isNew: boolean };
}

/**
 * Open slots: the same search the assistant runs in find_slots, by the one booking rule for the actor (core
 * bookingPolicy). For the desk, its own lead time (DESK_LEAD_MINUTES) and every start on the clinic's grid, not only
 * times a visit apart: the desk sees and can book them all, and a time sooner than that is squeezed in with Override.
 * For the assistant (MCP), the times a call offers: the visit's notice, its furthest date, a visit apart.
 */
export function openSlots(clinic: Clinic, busy: BusyInterval[], q: OpenSlotQuery): Slot[] {
  const visitType = clinic.visitTypes.find((v) => v.id === q.visitTypeId);
  if (!visitType) return [];
  const patient = q.patient;
  const providers = q.providerId ? clinic.providers.filter((p) => p.id === q.providerId)
    : bookableProviders(clinic.providers).filter((p) => !patient || (seesAge(p, patient.age) && (!patient.isNew || p.acceptingNewPatients)));
  return findSlots(clinic, busy, { visitType, providers, from: q.from, days: q.days, partOfDay: q.partOfDay, now: q.now, actor: q.actor, limit: q.limit ?? 200 });
}

/**
 * Whether one requested time can be booked, and if not, why. The decision is the
 * slot search's own: a time is bookable exactly when openSlots would offer it, so a
 * booking made at the desk follows the same rules as one made on the phone. The
 * checks before that only name the reason.
 *
 * With `override` (the front desk squeezing someone in, with a reason) the clinic's
 * hours, holidays, special days, the provider's absences, the lead time and the grid are not
 * checked; who, which visit, the past and a clash still are. The assistant never
 * overrides. `actor`: whose booking rule applies (core bookingPolicy), the desk's unless said.
 */
export function slotProblem(clinic: Clinic, busy: BusyInterval[], req: { providerId: string; visitTypeId: string; start: Date }, now: Date, opts: { override?: boolean; actor?: BookingActor } = {}): SlotProblem | null {
  const actor = opts.actor ?? 'desk';
  const provider = clinic.providers.find((p) => p.id === req.providerId);
  if (!provider) return 'unknown_provider';
  const visitType = clinic.visitTypes.find((v) => v.id === req.visitTypeId);
  if (!visitType) return 'unknown_visit_type';
  if (!provider.visitTypeIds.includes(visitType.id)) return 'not_offered';
  const date = localDateOf(req.start, clinic.timezone);
  const end = new Date(req.start.getTime() + visitType.minutes * 60_000);
  if (!opts.override) {
    const special = specialDayOf(clinic, date);
    // closed for everyone that day, except a vet the special day lists
    if ((special ? !special.windows.length : clinic.holidays.includes(date)) && !bookableWindows(clinic, provider, date).windows.length) return 'holiday';
  }
  if (req.start.getTime() <= now.getTime()) return 'past';
  if (!opts.override) {
    const problem = policyProblem(bookingPolicy(visitType, actor), req.start, now, clinic.timezone);
    if (problem) return problem;
  }
  if (!opts.override) {
    const m = localParts(req.start, clinic.timezone).minutes;
    if (awayOn(provider, date) || awayWindows(provider, date).some((a) => m < a.end && m + visitType.minutes > a.start)) return 'away';
    // on the clinic's start-time grid, whoever books: every start on it can be booked (the times a visit apart are only
    // what a caller is offered first), and the actor's own lead, notice and furthest date are checked above
    const grid = openSlots(clinic, [], { visitTypeId: visitType.id, providerId: provider.id, from: date, days: 1, now, actor: 'desk', limit: 1000 });
    if (!grid.some((s) => s.start.getTime() === req.start.getTime())) return 'closed';
  }
  return clashes(busy, clinic.visitTypes, provider.id, req.start, end, visitType.bufferMinutes ?? 0) ? 'taken' : null;
}
