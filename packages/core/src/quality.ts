// SPDX-License-Identifier: AGPL-3.0-only

/** One call as the quality numbers see it: outcome, codes and counts. */
export interface QualityCall {
  outcome: string | null;
  closeReason: string | null;
  voiceSeconds: number;
  flagged: boolean;
  triedToBook: boolean;
  callerTurns: number;
  refusals: string[];
  afterHours: boolean;
}

export interface QualityNumbers {
  calls: number;
  contained: number; containmentRate: number | null;
  bookingAttempts: number; bookings: number; bookingSuccess: number | null;
  avgTurnsToBooking: number | null;
  refusals: { code: string; count: number }[];
  transferred: number; transferredShare: number | null;
  flagged: number; flaggedShare: number | null;
  afterHours: number;
  voiceMinutes: number; cost: number; costPerCall: number | null; costPerBooking: number | null;
}

/** Outcomes where the assistant finished the call itself. A transfer, a request for staff or an emergency is not. */
export const CONTAINED_OUTCOMES = new Set(['booked', 'rescheduled', 'cancelled', 'info']);
const BOOKED = new Set(['booked', 'rescheduled']);
const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const money = (n: number) => Math.round(n * 100) / 100;

/**
 * The quality numbers for a set of calls: the same definitions for the dashboard's
 * weekly page and for simulated calls. Cost is voice minutes at `costPerMinute`.
 */
export function qualityOf(calls: QualityCall[], costPerMinute: number): QualityNumbers {
  const contained = calls.filter((c) => CONTAINED_OUTCOMES.has(c.outcome ?? '')).length;
  const attempts = calls.filter((c) => c.triedToBook);
  const booked = calls.filter((c) => BOOKED.has(c.outcome ?? ''));
  const refusals = new Map<string, number>();
  for (const c of calls) for (const code of c.refusals) refusals.set(code, (refusals.get(code) ?? 0) + 1);
  const transferred = calls.filter((c) => c.outcome === 'transferred' || c.closeReason === 'transferred').length;
  const flagged = calls.filter((c) => c.flagged).length;
  const minutes = calls.reduce((n, c) => n + c.voiceSeconds, 0) / 60;
  const cost = minutes * costPerMinute;
  return {
    calls: calls.length, contained, containmentRate: rate(contained, calls.length),
    bookingAttempts: attempts.length, bookings: booked.length, bookingSuccess: rate(attempts.filter((c) => BOOKED.has(c.outcome ?? '')).length, attempts.length),
    avgTurnsToBooking: booked.length ? Math.round((booked.reduce((n, c) => n + c.callerTurns, 0) / booked.length) * 10) / 10 : null,
    refusals: [...refusals].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    transferred, transferredShare: rate(transferred, calls.length), flagged, flaggedShare: rate(flagged, calls.length),
    afterHours: calls.filter((c) => c.afterHours).length,
    voiceMinutes: Math.round(minutes * 10) / 10, cost: money(cost), costPerCall: calls.length ? money(cost / calls.length) : null, costPerBooking: booked.length ? money(cost / booked.length) : null,
  };
}
