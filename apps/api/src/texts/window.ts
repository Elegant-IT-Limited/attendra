// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, localDateOf, zonedInstant } from '@attendra/core';

/**
 * The one window the dashboard counts texts over (SMALL-2, 2026-11-26): the last 7 clinic-local days, today included.
 * Today's "texts not handled" item, the notice and the Texts page's "Last 7 days" strip all use it, so the same count
 * reads the same everywhere (Today once said 35 over 3 days while Texts said 37 over 7).
 */
export const TEXT_WINDOW_DAYS = 7;

/** The window in the clinic's days: today's date, the first day (`from`, what the Texts page filters by) and its start. */
export function textWindow(now: Date, timeZone: string) {
  const todayDate = localDateOf(now, timeZone);
  const from = addDays(todayDate, -(TEXT_WINDOW_DAYS - 1));
  return { todayDate, from, today: zonedInstant(todayDate, '00:00', timeZone), since: zonedInstant(from, '00:00', timeZone) };
}
