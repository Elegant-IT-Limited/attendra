// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, type ClinicConfig, isOpen, localDateOf, qualityOf, weekdayOf, zonedInstant } from '@attendra/core';
import type { QualityRow } from '@attendra/db';
import type { QualityWeek } from '../contracts';

/** Monday of the clinic-local week a date falls in. */
export const weekStart = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));

/**
 * The quality page's numbers for the last `weeks` weeks, in the clinic's calendar,
 * newest first, with the definitions in packages/core/src/quality.ts. Cost is the
 * voice model's minutes at `costPerMinute`, the same estimate as the overview.
 */
export function qualityWeeks(rows: QualityRow[], clinic: ClinicConfig, now: Date, weeks: number, costPerMinute: number): QualityWeek[] {
  const thisWeek = weekStart(localDateOf(now, clinic.timezone));
  return Array.from({ length: weeks }, (_, i) => {
    const start = addDays(thisWeek, -7 * i);
    const from = zonedInstant(start, '00:00', clinic.timezone).getTime();
    const to = zonedInstant(addDays(start, 7), '00:00', clinic.timezone).getTime();
    const calls = rows.filter((r) => r.startedAt.getTime() >= from && r.startedAt.getTime() < to).map((r) => ({ ...r, afterHours: !isOpen(clinic, r.startedAt) }));
    return { start, end: addDays(start, 6), ...qualityOf(calls, costPerMinute) };
  });
}
