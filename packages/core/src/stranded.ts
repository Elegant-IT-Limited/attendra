// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig, Provider } from './clinic';
import { bookableWindows, specialDayOf } from './hours';
import { awayOn, awayWindows } from './providers';
import { localParts, toMinutes } from './time';

/**
 * Why a booked visit no longer sits in bookable time: the clinic closed that day (a holiday, or a special day whose
 * hours no longer hold it), its vet away then (all day or part of it), or outside the hours the vet is booked by (the
 * clinic's or their own, cut since it was booked).
 */
export type StrandedReason = 'holiday' | 'away' | 'outside_hours';

type Days = Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone'> & { specialDays?: ClinicConfig['specialDays'] };

/**
 * Why one booked visit is stranded, or null when it still fits: the one rule behind the Schedule's warning (GET
 * /appointments/conflicts) and the "move or keep" list a save of hours, a vet's hours or days off, a holiday or a
 * special day shows before it goes through. The test is the visit itself inside a window by the same rule every
 * booking follows (bookableWindows); its cleaning time may run past closing, as when it was booked (slots.ts). A visit
 * whose vet is no longer listed is judged by the clinic's days only.
 */
export function strandedReason(clinic: Days, provider: Pick<Provider, 'id' | 'hours' | 'timeOff'> | undefined, visit: { start: Date; end: Date }): StrandedReason | null {
  const { date, minutes } = localParts(visit.start, clinic.timezone);
  const end = minutes + Math.round((visit.end.getTime() - visit.start.getTime()) / 60_000);
  const holds = (w: { open: string; close: string }) => toMinutes(w.open) <= minutes && end <= toMinutes(w.close);
  const special = specialDayOf(clinic, date);
  // closed all day, or a special day whose hours no longer hold the whole visit; a vet the special day lists keeps their own hours
  const closedDay = special ? !special.windows.some(holds) : clinic.holidays.includes(date);
  if (closedDay && !(provider && special?.providerIds?.includes(provider.id))) return 'holiday';
  if (!provider) return null;
  if (awayOn(provider, date) || awayWindows(provider, date).some((a) => minutes < a.end && end > a.start)) return 'away';
  return bookableWindows(clinic, provider, date).windows.some(holds) ? null : 'outside_hours';
}

/** A booked visit as the check reads it: when, with whom. */
export interface BookedVisit { id: string; providerId: string; start: Date; end: Date }

/**
 * The visits a change of settings would strand that still fit before it: what the save asks "move or keep" about. A
 * visit already stranded (squeezed in with Override, or kept at an earlier change) is not asked about again.
 */
export function newlyStranded<V extends BookedVisit>(before: Days & Pick<ClinicConfig, 'providers'>, changed: Days & Pick<ClinicConfig, 'providers'>, visits: readonly V[]): (V & { reason: StrandedReason })[] {
  // the hours, days off, holidays and special days of the change, in the zone the visits were booked in: a time zone
  // corrected is not a change of hours, and asking about every visit it moves on the clock would bury the ones that are
  const after = { ...changed, timezone: before.timezone };
  const out: (V & { reason: StrandedReason })[] = [];
  for (const v of visits) {
    const reason = strandedReason(after, after.providers.find((p) => p.id === v.providerId), v);
    if (reason && !strandedReason(before, before.providers.find((p) => p.id === v.providerId), v)) out.push({ ...v, reason });
  }
  return out;
}

