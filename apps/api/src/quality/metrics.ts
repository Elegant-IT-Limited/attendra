// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, type ClinicConfig, isOpen, localDateOf, qualityOf, weekdayOf, zonedInstant } from '@attendra/core';
import type { QualityRow } from '@attendra/db';
import type { QualityWeek } from '../contracts';

/** Monday of the clinic-local week a date falls in. */
export const weekStart = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));

/**
 * How many weeks the quality page shows: from the clinic's sign-up week to this one,
 * at most `max` (and at least this week). A clinic three weeks old has three weeks,
 * not eight with five empty ones before it signed up.
 */
export function weeksSince(since: Date | null, now: Date, timezone: string, max: number): number {
  if (!since) return max;
  const first = weekStart(localDateOf(since, timezone));
  const thisWeek = weekStart(localDateOf(now, timezone));
  const weeks = Math.round((Date.parse(`${thisWeek}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
  return Math.min(max, Math.max(1, weeks));
}

/**
 * The quality page's numbers for the last `weeks` weeks, in the clinic's calendar,
 * newest first, with the definitions in packages/core/src/quality.ts. Cost is the
 * voice model's minutes at `costPerMinute`, the same estimate as the overview.
 * `rows` are phone calls only; `testCalls` are when the week's browser test calls
 * started, counted so the page can say how many it left out.
 */
export function qualityWeeks(rows: QualityRow[], clinic: ClinicConfig, now: Date, weeks: number, costPerMinute: number, testCalls: Date[] = []): QualityWeek[] {
  const thisWeek = weekStart(localDateOf(now, clinic.timezone));
  return Array.from({ length: weeks }, (_, i) => {
    const start = addDays(thisWeek, -7 * i);
    const from = zonedInstant(start, '00:00', clinic.timezone).getTime();
    const to = zonedInstant(addDays(start, 7), '00:00', clinic.timezone).getTime();
    const inWeek = (at: Date) => at.getTime() >= from && at.getTime() < to;
    const calls = rows.filter((r) => inWeek(r.startedAt)).map((r) => ({ ...r, afterHours: !isOpen(clinic, r.startedAt) }));
    return { start, end: addDays(start, 6), ...qualityOf(calls, costPerMinute), testCallsLeftOut: testCalls.filter(inWeek).length };
  });
}
