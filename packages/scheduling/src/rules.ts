// SPDX-License-Identifier: AGPL-3.0-only
import { type BusyInterval, type ClinicConfig, findSlots, localDateOf, type Slot } from '@attendra/core';

/** Why a time cannot be booked, in the words the API and the dashboard use. */
export type SlotProblem =
  | 'unknown_provider'
  | 'unknown_visit_type'
  | 'not_offered' // the provider does not do this visit type
  | 'holiday'
  | 'closed' // outside the provider's hours, or not on the visit's time grid
  | 'past'
  | 'taken';

type Clinic = Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone' | 'providers' | 'visitTypes'>;

export interface OpenSlotQuery {
  visitTypeId: string;
  providerId?: string | null;
  from: string; // local YYYY-MM-DD
  days: number;
  partOfDay?: 'morning' | 'afternoon' | 'any';
  now: Date;
  limit?: number;
}

/**
 * Open slots for the front desk. The same search the assistant runs in find_slots,
 * without its two-hour lead time: someone standing at the desk can take the 2:40.
 */
export function openSlots(clinic: Clinic, busy: BusyInterval[], q: OpenSlotQuery): Slot[] {
  const visitType = clinic.visitTypes.find((v) => v.id === q.visitTypeId);
  if (!visitType) return [];
  const providers = q.providerId ? clinic.providers.filter((p) => p.id === q.providerId) : clinic.providers;
  return findSlots(clinic, busy, { visitType, providers, from: q.from, days: q.days, partOfDay: q.partOfDay, now: q.now, leadMinutes: 0, limit: q.limit ?? 200 });
}

/**
 * Whether one requested time can be booked, and if not, why. The decision is the
 * slot search's own: a time is bookable exactly when openSlots would offer it, so a
 * booking made at the desk follows the same rules as one made on the phone. The
 * checks before that only name the reason.
 */
export function slotProblem(clinic: Clinic, busy: BusyInterval[], req: { providerId: string; visitTypeId: string; start: Date }, now: Date): SlotProblem | null {
  const provider = clinic.providers.find((p) => p.id === req.providerId);
  if (!provider) return 'unknown_provider';
  const visitType = clinic.visitTypes.find((v) => v.id === req.visitTypeId);
  if (!visitType) return 'unknown_visit_type';
  if (!provider.visitTypeIds.includes(visitType.id)) return 'not_offered';
  const date = localDateOf(req.start, clinic.timezone);
  if (clinic.holidays.includes(date)) return 'holiday';
  if (req.start.getTime() <= now.getTime()) return 'past';
  const grid = openSlots(clinic, [], { visitTypeId: visitType.id, providerId: provider.id, from: date, days: 1, now, limit: 1000 });
  if (!grid.some((s) => s.start.getTime() === req.start.getTime())) return 'closed';
  const end = req.start.getTime() + visitType.minutes * 60_000;
  const clash = busy.some((b) => b.providerId === provider.id && b.start.getTime() < end && req.start.getTime() < b.end.getTime());
  return clash ? 'taken' : null;
}
