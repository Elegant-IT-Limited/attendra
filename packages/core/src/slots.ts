// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, PACKS } from './locales';
import type { ClinicConfig, Provider, VisitType } from './clinic';
import { specialDayOf, windowsOn } from './hours';
import { awayOn, awayWindows } from './providers';
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
  /** The earliest local time of day the caller wants (HH:MM): "after 3" or "at 3:30". */
  fromTime?: string;
  now: Date;
  leadMinutes?: number; // no same-hour surprises for the front desk
  limit?: number;
  /** Several free at the same moment: the one with the fewest visits that day ('fewest'), or the list's order (the default). */
  tieBreak?: 'order' | 'fewest';
  /** One slot per start time: the first of those free then, so a caller hears three different times, not one time three times. */
  distinctTimes?: boolean;
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
export function findSlots(clinic: Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone'> & { visitTypes?: VisitType[]; specialDays?: ClinicConfig['specialDays'] }, busy: BusyInterval[], q: SlotQuery): Slot[] {
  const limit = q.limit ?? 3;
  const earliest = q.now.getTime() + (q.leadMinutes ?? 120) * MINUTE;
  const buffer = q.visitType.bufferMinutes ?? 0;
  const step = q.visitType.minutes + buffer;
  const out: Slot[] = [];
  for (let i = 0; i < q.days && out.length < limit; i++) {
    const date = addDays(q.from, i);
    // a special day has its own hours; a holiday, none
    const special = specialDayOf(clinic, date);
    if (special ? !special.windows.length : clinic.holidays.includes(date)) continue;
    const weekday = weekdayOf(date);
    const day: { slot: Slot; order: number }[] = [];
    q.providers.forEach((provider, order) => {
      if (!provider.visitTypeIds.includes(q.visitType.id) || awayOn(provider, date)) return;
      const away = awayWindows(provider, date);
      // a provider's own hours are kept inside the clinic's that day (a special day's own, or the week's):
      // nobody is seen while the clinic is closed, at lunch or after hours, whatever their own hours say
      const open = special ? special.windows : windowsOn(clinic.hours, weekday);
      const windows = provider.hours ? intersect(windowsOn(provider.hours, weekday), open) : open;
      for (const w of windows) {
        for (let m = toMinutes(w.open); m + q.visitType.minutes <= toMinutes(w.close); m += step) {
          if (q.partOfDay === 'morning' && m >= 12 * 60) break;
          if (q.partOfDay === 'afternoon' && m < 12 * 60) continue;
          if (q.fromTime && m < toMinutes(q.fromTime)) continue;
          // away for part of the day: nothing that overlaps it
          if (away.some((a) => m < a.end && m + q.visitType.minutes > a.start)) continue;
          const start = zonedInstant(date, fromMinutes(m), clinic.timezone);
          const end = new Date(start.getTime() + q.visitType.minutes * MINUTE);
          if (start.getTime() < earliest) continue;
          if (clashes(busy, clinic.visitTypes, provider.id, start, end, buffer)) continue;
          day.push({ slot: { id: slotId(provider.id, start), providerId: provider.id, visitTypeId: q.visitType.id, start, end }, order });
        }
      }
    });
    // the visits each one already has that day, for a tie broken by the fewest
    const load = (providerId: string) => (q.tieBreak === 'fewest'
      ? busy.filter((b) => b.providerId === providerId && localParts(b.start, clinic.timezone).date === date).length : 0);
    const loads = new Map(q.providers.map((p) => [p.id, load(p.id)]));
    day.sort((a, b) => a.slot.start.getTime() - b.slot.start.getTime() || loads.get(a.slot.providerId)! - loads.get(b.slot.providerId)! || a.order - b.order);
    for (const { slot } of day) {
      if (q.distinctTimes && out.some((s) => s.start.getTime() === slot.start.getTime())) continue;
      out.push(slot);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** The parts of two lists of windows that overlap. */
function intersect(a: { open: string; close: string }[], b: { open: string; close: string }[]) {
  const out: { open: string; close: string }[] = [];
  for (const x of a) for (const y of b) {
    const open = Math.max(toMinutes(x.open), toMinutes(y.open));
    const close = Math.min(toMinutes(x.close), toMinutes(y.close));
    if (open < close) out.push({ open: fromMinutes(open), close: fromMinutes(close) });
  }
  return out;
}

/** "Thursday at 10:00 AM" (with `now`: today, tomorrow, the weekday within the week), else "Thursday, October 1 at 10:00 AM", in the clinic's zone and the caller's language. */
export function speakSlot(start: Date, timeZone: string, language: Language = 'en', now?: Date): string {
  return PACKS[language].speakWhen(start, timeZone, now);
}

export function localDateOf(at: Date, timeZone: string) {
  return localParts(at, timeZone).date;
}
