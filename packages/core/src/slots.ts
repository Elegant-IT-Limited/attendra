// SPDX-License-Identifier: AGPL-3.0-only
import { type Language, PACKS } from './locales';
import { bookingOf, type ClinicConfig, type Provider, type VisitType } from './clinic';
import { bookableWindows, insideWindows } from './hours';
import { awayOn, awayWindows, providerName } from './providers';
import { addDays, fromMinutes, localParts, toMinutes, zonedInstant } from './time';

/** Booked time. With its visit type, a visit that keeps a buffer after it blocks that too. */
export interface BusyInterval { providerId: string; start: Date; end: Date; visitTypeId?: string }

export interface Slot {
  id: string; // stable: provider + start, so the same slot offered twice has one id
  providerId: string;
  visitTypeId: string;
  start: Date;
  end: Date;
  /** The vet sees patients then by their own hours while the clinic's front desk is closed: the caller is told so. */
  outsideClinicHours?: boolean;
}

/** Which side of the caller's time to look: "around 5" (either), "earlier than 6" (before), "after 3" (after). */
export type NearDirection = 'around' | 'before' | 'after';

export interface SlotQuery {
  visitType: VisitType;
  providers: Provider[]; // already filtered to the ones the caller asked for, if any
  from: string; // local YYYY-MM-DD, inclusive
  days: number;
  partOfDay?: 'morning' | 'afternoon' | 'any';
  /** Earliest first, no earlier than this local time of day (HH:MM). */
  fromTime?: string;
  now: Date;
  leadMinutes?: number; // no same-hour surprises for the front desk
  limit?: number;
  /** Several free at the same moment: the one with the fewest visits that day ('fewest'), or the list's order (the default). */
  tieBreak?: 'order' | 'fewest';
  /** One slot per start time: the first of those free then, so a caller hears three different times, not one time three times. */
  distinctTimes?: boolean;
  /**
   * The times nearest to one the caller named on a day ("is 4 PM free?"): the exact time first when it is free, then
   * that day's nearest on the allowed side, closest first ("not at 4, but 3:50 or 4:20"). When that day has nothing,
   * the free time nearest to it on each next working day, one a day, with `days` as the window.
   */
  near?: { date: string; time: string; direction: NearDirection };
  /** Every free start on the grid (the desk's picker and its checks), not only times a visit apart. */
  allStarts?: boolean;
  /** The clinic's start-time grid in minutes; by default its booking rules' startEvery. */
  startEvery?: number;
}

/** How far ahead the assistant books, in minutes: no same-hour surprises for the front desk. */
export const BOOKING_LEAD_MINUTES = 120;
/**
 * How far ahead the front desk books, in minutes: someone standing at the desk can take the 2:40, but not a time that
 * has begun by the time it is picked and confirmed (2026-11-15: the New booking dialog offered a time already past).
 * The dialog reads it from the slots API; a sooner walk-in is the desk's Override.
 */
export const DESK_LEAD_MINUTES = 5;

export const slotId = (providerId: string, start: Date) => `${providerId}@${start.toISOString()}`;

const MINUTE = 60_000;
/**
 * The minutes a visit type keeps free after each visit (cleaning time), 0 when none: the slot search's, the schedule
 * grid's drawn tail, and the database's own (migration 0053 reads the same setting for its exclusion).
 */
export const bufferOf = (visitTypes: readonly Pick<VisitType, 'id' | 'bufferMinutes'>[] | undefined, id: string | undefined) => (id ? visitTypes?.find((v) => v.id === id)?.bufferMinutes ?? 0 : 0);

/**
 * Whether a visit from start to end, keeping `buffer` minutes free after it, overlaps
 * booked time; each booked visit also keeps its own type's buffer after it.
 */
export function clashes(busy: BusyInterval[], visitTypes: Pick<VisitType, 'id' | 'bufferMinutes'>[] | undefined, providerId: string, start: Date, end: Date, buffer = 0) {
  return busy.some((b) => b.providerId === providerId
    && b.start.getTime() < end.getTime() + buffer * MINUTE
    && start.getTime() < b.end.getTime() + bufferOf(visitTypes, b.visitTypeId) * MINUTE);
}

type SlotClinic = Pick<ClinicConfig, 'hours' | 'holidays' | 'timezone'> & { visitTypes?: VisitType[]; specialDays?: ClinicConfig['specialDays']; booking?: ClinicConfig['booking'] };

/**
 * The starts on a window: its opening, then every clock multiple of `every` after it (8:05, 8:10, 8:20 on a 10-minute
 * grid), as long as the visit ends inside the window. Its buffer is cleaning time, not patient time, and may run past
 * closing (approved 2026-11-08): a 20-minute visit with 10 minutes after it may start at 16:40 on a 17:00 close.
 */
export function gridStarts(open: number, close: number, length: number, every: number): number[] {
  const out: number[] = [];
  for (let m = open; m + length <= close; m = (Math.floor(m / every) + 1) * every) out.push(m);
  return out;
}

/** Every free start on one date, all providers, in the order found (provider by provider), each with its provider's place in the list. */
function freeOnDay(clinic: SlotClinic, busy: BusyInterval[], q: SlotQuery, date: string, earliest: number): { slot: Slot; order: number }[] {
  const buffer = q.visitType.bufferMinutes ?? 0;
  const every = q.startEvery ?? bookingOf(clinic).startEvery;
  const out: { slot: Slot; order: number }[] = [];
  q.providers.forEach((provider, order) => {
    if (!provider.visitTypeIds.includes(q.visitType.id) || awayOn(provider, date)) return;
    const away = awayWindows(provider, date);
    // the vet's own hours decide, even outside the clinic's; the clinic's are for vets with none (bookableWindows)
    const { windows, clinicWindows } = bookableWindows(clinic, provider, date);
    for (const w of windows) {
      // the visit inside the window; its buffer may run past the close, and still never into another visit (clashes)
      for (const m of gridStarts(toMinutes(w.open), toMinutes(w.close), q.visitType.minutes, every)) {
        // away for part of the day: nothing that overlaps it
        if (away.some((a) => m < a.end && m + q.visitType.minutes > a.start)) continue;
        const start = zonedInstant(date, fromMinutes(m), clinic.timezone);
        if (start.getTime() < earliest) continue;
        const end = new Date(start.getTime() + q.visitType.minutes * MINUTE);
        if (clashes(busy, clinic.visitTypes, provider.id, start, end, buffer)) continue;
        out.push({ slot: { id: slotId(provider.id, start), providerId: provider.id, visitTypeId: q.visitType.id, start, end, outsideClinicHours: !insideWindows(clinicWindows, m) }, order });
      }
    }
  });
  return out;
}

/**
 * Free slots in clinic-local time, earliest first: day by day, and within a day by
 * start time across every provider, with the providers' given order breaking a tie,
 * so results are deterministic. Starts sit on the clinic's grid (every 10 minutes by
 * default), and the times offered are spread a visit apart (8:00, 8:20, 8:40 for a
 * 20-minute visit), while any start on the grid can be asked for and booked.
 * With `near`, the times nearest to the one the caller named instead.
 */
export function findSlots(clinic: SlotClinic, busy: BusyInterval[], q: SlotQuery): Slot[] {
  const limit = q.limit ?? 3;
  const earliest = q.now.getTime() + (q.leadMinutes ?? BOOKING_LEAD_MINUTES) * MINUTE;
  const gap = (q.visitType.minutes + (q.visitType.bufferMinutes ?? 0)) * MINUTE;
  const minutesOf = (s: Slot) => localParts(s.start, clinic.timezone).minutes;
  // the visits each one already has that day, for a tie broken by the fewest
  const loadOn = (date: string) => {
    const loads = new Map(q.providers.map((p) => [p.id, q.tieBreak === 'fewest' ? busy.filter((b) => b.providerId === p.id && localParts(b.start, clinic.timezone).date === date).length : 0]));
    return (id: string) => loads.get(id) ?? 0;
  };
  // a time offered is a visit apart from the ones already offered that day (with that vet, or with anyone when the times are distinct)
  const fits = (chosen: Slot[], slot: Slot) => !chosen.some((c) => (q.distinctTimes ? c.start.getTime() === slot.start.getTime() : false)
    || (!q.allStarts && (q.distinctTimes || c.providerId === slot.providerId) && localDateOf(c.start, clinic.timezone) === localDateOf(slot.start, clinic.timezone)
      && Math.abs(c.start.getTime() - slot.start.getTime()) < gap));

  if (q.near) {
    const target = toMinutes(q.near.time);
    const side = (m: number) => (q.near!.direction === 'before' ? m < target : q.near!.direction === 'after' ? m >= target : true);
    const ranked = (date: string) => {
      const load = loadOn(date);
      return freeOnDay(clinic, busy, q, date, earliest).filter(({ slot }) => side(minutesOf(slot)))
        .sort((a, b) => Math.abs(minutesOf(a.slot) - target) - Math.abs(minutesOf(b.slot) - target) || a.slot.start.getTime() - b.slot.start.getTime()
          || load(a.slot.providerId) - load(b.slot.providerId) || a.order - b.order)
        .map((x) => x.slot);
    };
    const that = ranked(q.near.date);
    if (that.length) {
      // around a time: the nearest on each side first ("3:50 or 4:20"), then the rest by distance
      const exact = that.filter((s) => minutesOf(s) === target);
      const before = that.find((s) => minutesOf(s) < target);
      const after = that.find((s) => minutesOf(s) > target);
      // the time asked for and the nearest on each side are always said, however close together
      const lead = [...exact.slice(0, 1), ...[before, after].filter((s): s is Slot => !!s).sort((a, b) => Math.abs(minutesOf(a) - target) - Math.abs(minutesOf(b) - target))].slice(0, limit);
      const out: Slot[] = [...lead];
      for (const s of that) {
        if (out.length >= limit) break;
        if (out.includes(s) || !fits(out, s)) continue;
        out.push(s);
      }
      return out;
    }
    // nothing that day: the nearest to that time on each next working day, one a day
    const out: Slot[] = [];
    for (let i = 1; i < q.days && out.length < limit; i++) {
      const date = addDays(q.near.date, i);
      if (date < q.from) continue;
      const best = ranked(date)[0];
      if (best) out.push(best);
    }
    return out;
  }

  const out: Slot[] = [];
  for (let i = 0; i < q.days && out.length < limit; i++) {
    const date = addDays(q.from, i);
    const load = loadOn(date);
    const day = freeOnDay(clinic, busy, q, date, earliest).filter(({ slot }) => {
      const m = minutesOf(slot);
      if (q.partOfDay === 'morning' && m >= 12 * 60) return false;
      if (q.partOfDay === 'afternoon' && m < 12 * 60) return false;
      return !(q.fromTime && m < toMinutes(q.fromTime));
    });
    day.sort((a, b) => a.slot.start.getTime() - b.slot.start.getTime() || load(a.slot.providerId) - load(b.slot.providerId) || a.order - b.order);
    for (const { slot } of day) {
      if (!fits(out, slot)) continue;
      out.push(slot);
      if (out.length >= limit) return out;
    }
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

/** Slots by the clinic-local day they fall on, the days in the order they first appear, each day's times in time order. */
export function groupSlotsByDay(slots: Slot[], timeZone: string): { date: string; slots: Slot[] }[] {
  const days: { date: string; slots: Slot[] }[] = [];
  for (const slot of slots) {
    const date = localDateOf(slot.start, timeZone);
    const day = days.find((d) => d.date === date);
    if (day) day.slots.push(slot); else days.push({ date, slots: [slot] });
  }
  for (const d of days) d.slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  return days;
}

/**
 * Several offered times in one sentence, each date said once: "On Wednesday, November 4, I have 8:00, 8:40 or 9:20 AM
 * with Dr. Ruiz." The vet is said once when all the times are with one (a person; a room is not named), and with each
 * time when they differ.
 */
export function offerTimesLine(slots: Slot[], clinic: Pick<ClinicConfig, 'timezone' | 'providers'>, language: Language = 'en'): string {
  const people = new Set(slots.map((s) => s.providerId));
  const nameOf = (id: string) => { const p = clinic.providers.find((x) => x.id === id); return p && p.kind !== 'room' ? providerName(p, language) : null; };
  const one = people.size === 1 ? nameOf(slots[0]!.providerId) : null;
  const days = groupSlotsByDay(slots, clinic.timezone).map((d) => ({
    date: d.date,
    times: d.slots.map((s) => { const m = localParts(s.start, clinic.timezone).minutes; return { hour: Math.floor(m / 60), minute: m % 60, provider: people.size > 1 ? nameOf(s.providerId) : null }; }),
  }));
  return PACKS[language].spoken.offerTimes({ days, provider: one });
}

/**
 * How a move shifts the day, in the caller's language ("that's one week later, Wednesday, November 11"), or null when
 * the new time is on the same day as the old one.
 */
export function dayShift(from: Date, to: Date, timeZone: string, language: Language = 'en'): string | null {
  const [a, b] = [localDateOf(from, timeZone), localDateOf(to, timeZone)];
  if (a === b) return null;
  const days = Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);
  return PACKS[language].spoken.dayShift({ days, day: PACKS[language].fullDay(b) });
}
