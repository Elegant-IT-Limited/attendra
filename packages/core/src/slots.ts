// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, PACKS } from './locales';
import type { ClinicConfig, Provider, VisitType } from './clinic';
import { windowsOn } from './hours';
import { addDays, fromMinutes, localParts, toMinutes, weekdayOf, zonedInstant } from './time';

export interface BusyInterval { providerId: string; start: Date; end: Date }

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

/**
 * Free slots in clinic-local time, walking days in order and providers in the order
 * given, so results are deterministic and the earliest options come first. The step
 * is the visit length: a 30-minute visit offers 9:00, 9:30, 10:00.
 */
export function findSlots(clinic: Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone'>, busy: BusyInterval[], q: SlotQuery): Slot[] {
  const limit = q.limit ?? 3;
  const earliest = q.now.getTime() + (q.leadMinutes ?? 120) * 60_000;
  const out: Slot[] = [];
  for (let i = 0; i < q.days && out.length < limit; i++) {
    const date = addDays(q.from, i);
    if (clinic.holidays.includes(date)) continue;
    const weekday = weekdayOf(date);
    for (const provider of q.providers) {
      if (!provider.visitTypeIds.includes(q.visitType.id)) continue;
      const windows = windowsOn(provider.hours ?? clinic.hours, weekday);
      for (const w of windows) {
        for (let m = toMinutes(w.open); m + q.visitType.minutes <= toMinutes(w.close); m += q.visitType.minutes) {
          if (q.partOfDay === 'morning' && m >= 12 * 60) break;
          if (q.partOfDay === 'afternoon' && m < 12 * 60) continue;
          const start = zonedInstant(date, fromMinutes(m), clinic.timezone);
          const end = new Date(start.getTime() + q.visitType.minutes * 60_000);
          if (start.getTime() < earliest) continue;
          const clash = busy.some((b) => b.providerId === provider.id && b.start < end && start < b.end);
          if (clash) continue;
          out.push({ id: slotId(provider.id, start), providerId: provider.id, visitTypeId: q.visitType.id, start, end });
          if (out.length >= limit) return out;
        }
      }
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
