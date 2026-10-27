// SPDX-License-Identifier: AGPL-3.0-only
/**
 * find_slots stages a free exact time itself: the find-then-propose pair becomes one call when the caller named the
 * time (2026-11). Said in the tool's description for every industry.
 */
export const PROPOSE_IF_EXACT = 'propose_if_exact: true only when the caller asked for one exact day and time ("Thursday at 2:30": from_date and from_time both set) for a new booking and is already verified: if that exact time is free it is staged at once and its read-back is spoken for their yes, so you do not call propose_booking; if not, the nearest times come back as usual. Never for a move of an existing appointment, and null before verification.';
