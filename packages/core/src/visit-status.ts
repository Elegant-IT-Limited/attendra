// SPDX-License-Identifier: AGPL-3.0-only
import { localDateOf } from './slots';

/**
 * A visit's state (migration 0054): one list for the database check, the API, the
 * dashboard and the assistant.
 *
 *   booked     on the calendar, still to happen (or not marked yet)
 *   arrived    the pet is at the clinic (the desk marked it)
 *   completed  the visit took place
 *   no_show    nobody came
 *   cancelled  called off (by the owner, the clinic, or the assistant)
 *
 * The desk moves a visit between the first four, and back, each change audited with
 * who and when. Only a booked visit is "upcoming" for the assistant, and only a booked
 * visit can be moved or cancelled.
 */
export const VISIT_STATUSES = ['booked', 'arrived', 'completed', 'no_show', 'cancelled'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

/** What the desk sets on the schedule. "booked" is the way back. */
export const DESK_STATUSES = ['booked', 'arrived', 'completed', 'no_show'] as const satisfies readonly VisitStatus[];
export type DeskStatus = (typeof DESK_STATUSES)[number];

/**
 * The states that keep the vet's time: the double-booking guard in the database
 * (migration 0054 rewrites the exclusion constraint to exactly this list), the open-slot
 * search and the desk's clash check. A no-show frees its time for a walk-in; a
 * cancelled visit frees it at once.
 */
export const HOLDS_TIME = ['booked', 'arrived', 'completed'] as const satisfies readonly VisitStatus[];

/** Whether a visit in this state keeps its time on the vet's calendar. */
export const holdsTime = (status: string) => (HOLDS_TIME as readonly string[]).includes(status);

/**
 * Whether a past visit took place, for the patient's usual vet and their last visit: a
 * booked one nobody marked counts (most clinics will never mark them), a no-show and a
 * cancelled one do not.
 */
export const tookPlace = (status: string) => holdsTime(status);

/** The words the dashboard shows for each state. */
export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  booked: 'Booked', arrived: 'Arrived', completed: 'Completed', no_show: 'No-show', cancelled: 'Cancelled',
};

/** The key on the visit panel for each desk state ("b" puts it back to booked). */
export const DESK_STATUS_KEYS: Record<DeskStatus, string> = { booked: 'b', arrived: 'a', completed: 'd', no_show: 'n' };

export type DeskStatusProblem = 'cancelled' | 'too_early' | 'not_started';

/**
 * Whether the desk may set this state now, or why not: one rule for the API and the
 * panel's buttons. Arrived and completed from the visit's own day (in the clinic's time
 * zone); a no-show only once its start time has passed; back to booked at any time.
 * A cancelled visit keeps its state: book a new one instead.
 */
export function deskStatusProblem(visit: { status: string; startsAt: Date }, to: DeskStatus, now: Date, timeZone: string): DeskStatusProblem | null {
  if (visit.status === 'cancelled') return 'cancelled';
  if (to === 'booked') return null;
  if (to === 'no_show') return visit.startsAt.getTime() <= now.getTime() ? null : 'not_started';
  return localDateOf(visit.startsAt, timeZone) <= localDateOf(now, timeZone) ? null : 'too_early';
}

/** What the desk is told when a state cannot be set, by the problem's code. */
export const DESK_STATUS_REFUSED: Record<DeskStatusProblem, string> = {
  cancelled: 'This appointment is cancelled. Book a new one instead.',
  too_early: 'A visit can be marked arrived or completed from its own day.',
  not_started: 'A visit can be marked a no-show once its start time has passed.',
};
