// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a visit's panel offers its changes (Reschedule, Cancel, and the buttons of each). A booked visit
 * still ahead does; once it has started the server refuses a change. A change already begun keeps its
 * buttons when the start passes meanwhile, so the person is told why it was not saved instead of being
 * left with a time picker and nothing to press.
 */
export function offersChanges(visit: { status: string; startsAt: string }, now: Date, changing: boolean) {
  return visit.status === 'booked' && (changing || Date.parse(visit.startsAt) > now.getTime());
}
