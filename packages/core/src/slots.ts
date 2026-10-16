// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, PACKS } from './locales';
import type { ClinicConfig, Provider, VisitType } from './clinic';
import { windowsOn } from './hours';
import { awayOn } from './providers';
import { addDays, fromMinutes, localParts, toMinutes, weekdayOf, zonedInstant } from './time';

/** Booked time. With its visit type, a visit that keeps a buffer after it blocks that too. */
export interface BusyInterval { providerId: string; start: Date; end: Date; visitTypeId?: string }

export interface Slot {
  id: string; // stable: provider + start, so the same slot offered twice has one id
  providerId: string;
  visitTypeId: string;
  start: Date;
  end: Date;
}

export interface SlotQuery {
  visitType: VisitType;
  providers: Provider[]; // already filtered to the ones the caller asked for, if any
  from: string; // local YYYY-MM-DD, inclusive
  days: number;
  partOfDay?: 'morning' | 'afternoon' | 'any';
  now: Date;
  leadMinutes?: number; // no same-hour surprises for the front desk
  limit?: number;
}

export const slotId = (providerId: string, start: Date) => `${providerId}@${start.toISOString()}`;

const MINUTE = 60_000;
const bufferOf = (visitTypes: Pick<VisitType, 'id' | 'bufferMinutes'>[] | undefined, id: string | undefined) => (id ? visitTypes?.find((v) => v.id === id)?.bufferMinutes ?? 0 : 0);

/**
 * Whether a visit from start to end, keeping `buffer` minutes free after it, overlaps
 * booked time; each booked visit also keeps its own type's buffer after it.
 */
export function clashes(busy: BusyInterval[], visitTypes: Pick<VisitType, 'id' | 'bufferMinutes'>[] | undefined, providerId: string, start: Date, end: Date, buffer = 0) {
  return busy.some((b) => b.providerId === providerId
    && b.start.getTime() < end.getTime() + buffer * MINUTE
    && start.getTime() < b.end.getTime() + bufferOf(visitTypes, b.visitTypeId) * MINUTE);
}

/**
 * Free slots in clinic-local time, earliest first: day by day, and within a day by
 * start time across every provider, with the providers' given order breaking a tie,
 * so results are deterministic. The step is the visit length: a 30-minute visit
 * offers 9:00, 9:30, 10:00, and with a 10-minute buffer after it 9:00, 9:40, 10:20.
 */
export function findSlots(clinic: Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone'> & { visitTypes?: VisitType[] }, busy: BusyInterval[], q: SlotQuery): Slot[] {
  const limit = q.limit ?? 3;
  const earliest = q.now.getTime() + (q.leadMinutes ?? 120) * MINUTE;
  const buffer = q.visitType.bufferMinutes ?? 0;
  const step = q.visitType.minutes + buffer;
  const out: Slot[] = [];
  for (let i = 0; i < q.days && out.length < limit; i++) {
    const date = addDays(q.from, i);
    if (clinic.holidays.includes(date)) continue;
    const weekday = weekdayOf(date);
    const day: { slot: Slot; order: number }[] = [];
    q.providers.forEach((provider, order) => {
      if (!provider.visitTypeIds.includes(q.visitType.id) || awayOn(provider, date)) return;
      for (const w of windowsOn(provider.hours ?? clinic.hours, weekday)) {
        for (let m = toMinutes(w.open); m + q.visitType.minutes <= toMinutes(w.close); m += step) {
          if (q.partOfDay === 'morning' && m >= 12 * 60) break;
          if (q.partOfDay === 'afternoon' && m < 12 * 60) continue;
          const start = zonedInstant(date, fromMinutes(m), clinic.timezone);
          const end = new Date(start.getTime() + q.visitType.minutes * MINUTE);
          if (start.getTime() < earliest) continue;
          if (clashes(busy, clinic.visitTypes, provider.id, start, end, buffer)) continue;
          day.push({ slot: { id: slotId(provider.id, start), providerId: provider.id, visitTypeId: q.visitType.id, start, end }, order });
        }
      }
    });
    day.sort((a, b) => a.slot.start.getTime() - b.slot.start.getTime() || a.order - b.order);
    for (const { slot } of day) {
      out.push(slot);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** "Thursday, October 1 at 10:00 AM", in the clinic's zone and the caller's language, for read-back to the caller. */
export function speakSlot(start: Date, timeZone: string, language: Language = 'en'): string {
  return PACKS[language].speakWhen(start, timeZone);
}

export function localDateOf(at: Date, timeZone: string) {
  return localParts(at, timeZone).date;
}
