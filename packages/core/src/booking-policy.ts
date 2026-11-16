// SPDX-License-Identifier: AGPL-3.0-only
import type { VisitType } from './clinic';
import { addDays, localParts } from './time';

/**
 * Who is booking: the assistant (a call, and anything that offers times for a caller to take, such as an MCP agent), or
 * the front desk (staff in the dashboard, with Override for anything sooner or outside the rules).
 */
export type BookingActor = 'assistant' | 'desk';

/** How far ahead the assistant books, in minutes: no same-hour surprises for the front desk. */
export const BOOKING_LEAD_MINUTES = 120;
/**
 * How far ahead the front desk books, in minutes: someone standing at the desk can take the 2:40, but not a time that
 * has begun by the time it is picked and confirmed (2026-11-15: the New booking dialog offered a time already past).
 * The dialog reads it from the slots API; a sooner walk-in is the desk's Override.
 */
export const DESK_LEAD_MINUTES = 5;

/**
 * The one booking rule for a visit type and who books it (foundation A, 2026-11-17): every surface that lists or books
 * a time reads it here (findSlots, the desk's slotProblem, the assistant's find_slots, MCP's find_open_slots), so a
 * time one of them offers is never one another refuses for the same actor. Before this the assistant's tool had its own
 * lead and furthest date, and MCP listed times the phone would not book.
 */
export interface BookingPolicy {
  actor: BookingActor;
  /**
   * Minutes from now before a visit may start: the assistant's two hours, or the visit type's notice when it is longer;
   * the desk's five minutes (its notice and furthest date are the assistant's rules: the desk books what it judges).
   */
  leadMinutes: number;
  /** The visit type's notice in hours, when this actor keeps to it; 0 when there is none or the actor does not. */
  noticeHours: number;
  /** The furthest date, in days from today (today plus this is the last bookable date); null when there is no limit. */
  maxDaysAhead: number | null;
  /** Every free start on the clinic's grid (the desk's picker), or only times a visit apart (what a caller is offered). */
  allStarts: boolean;
}

export function bookingPolicy(visitType: Pick<VisitType, 'noticeHours' | 'maxDaysAhead'>, actor: BookingActor): BookingPolicy {
  if (actor === 'desk') return { actor, leadMinutes: DESK_LEAD_MINUTES, noticeHours: 0, maxDaysAhead: null, allStarts: true };
  const noticeHours = visitType.noticeHours ?? 0;
  return { actor, leadMinutes: Math.max(BOOKING_LEAD_MINUTES, noticeHours * 60), noticeHours, maxDaysAhead: visitType.maxDaysAhead ?? null, allStarts: false };
}

/** The first moment a visit may start under this policy. */
export const earliestStart = (policy: BookingPolicy, now: Date) => new Date(now.getTime() + policy.leadMinutes * 60_000);

/** The last date (clinic-local YYYY-MM-DD) a visit may be booked for under this policy, or null when there is no limit. */
export const lastBookableDate = (policy: BookingPolicy, now: Date, timeZone: string) =>
  policy.maxDaysAhead ? addDays(localParts(now, timeZone).date, policy.maxDaysAhead) : null;

/**
 * Why this policy refuses a start, or null: already begun ('past'), sooner than the actor's lead time ('too_soon'),
 * inside the visit type's notice when that is longer ('notice', the assistant only), or after the furthest date
 * ('too_far_ahead', the assistant only).
 */
export function policyProblem(policy: BookingPolicy, start: Date, now: Date, timeZone: string): 'past' | 'too_soon' | 'notice' | 'too_far_ahead' | null {
  if (start.getTime() <= now.getTime()) return 'past';
  if (start.getTime() < earliestStart(policy, now).getTime()) {
    // the visit's own notice when that is what sets the lead, else the actor's lead time
    return policy.noticeHours * 60 > BOOKING_LEAD_MINUTES ? 'notice' : 'too_soon';
  }
  const last = lastBookableDate(policy, now, timeZone);
  return last && localParts(start, timeZone).date > last ? 'too_far_ahead' : null;
}
