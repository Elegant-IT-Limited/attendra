// SPDX-License-Identifier: AGPL-3.0-only
import { awayOn, type ClinicConfig, specialDayOf, weekdayOf, windowsOn } from '@attendra/core';

type Provider = ClinicConfig['providers'][number];
type Clinic = Pick<ClinicConfig, 'hours' | 'holidays' | 'specialDays'>;

/** Past this many bookable providers the day grid shows only the lanes in use, and the Vets picker appears. */
export const MANY_PROVIDERS = 8;
/** Past this many bookable providers the Schedule opens on the Agenda, which reads at any size. */
export const AGENDA_FIRST = 30;
/** How many lanes the picker lets one person pin: more than this no longer fits a screen. */
export const MAX_CHOSEN = 8;

/** A provider's hours on a date: a special day's own stand in for the week's. */
export const hoursFor = (clinic: Clinic, p: Pick<Provider, 'hours'>, date: string) =>
  specialDayOf(clinic, date)?.windows ?? windowsOn(p.hours ?? clinic.hours, weekdayOf(date));

/** Closed all day: a holiday, or a special day with no hours. What the calendar says instead of hours. */
export const closedDay = (clinic: Clinic, date: string) => {
  const special = specialDayOf(clinic, date);
  if (special) return special.windows.length ? null : special.note || 'Closed';
  return clinic.holidays.includes(date) ? 'Holiday' : null;
};

/** Working on a date: the clinic is open, they have hours that day, and they are not away. */
export const worksOn = (clinic: Clinic, p: Pick<Provider, 'hours' | 'timeOff'>, date: string) =>
  !closedDay(clinic, date) && !awayOn(p, date) && hoursFor(clinic, p, date).length > 0;

/**
 * The lanes the grid draws. A clinic of a few providers shows them all, as it always has.
 * Past MANY_PROVIDERS a grid of everyone is unreadable, so a lane is drawn only for someone
 * working on one of the dates who has a visit then or was picked in the Vets picker. A
 * provider with a visit on screen keeps a lane whether or not they are working (a visit
 * squeezed in on a day off), so nothing booked ever vanishes from the grid.
 */
export function laneProviders<P extends Pick<Provider, 'id' | 'hours' | 'timeOff'>>(
  clinic: Clinic, listed: P[], dates: string[], booked: Iterable<string>, chosen: readonly string[],
): P[] {
  if (listed.length <= MANY_PROVIDERS) return listed;
  const withVisits = new Set(booked);
  const picked = new Set(chosen);
  return listed.filter((p) => withVisits.has(p.id) || (picked.has(p.id) && dates.some((d) => worksOn(clinic, p, d))));
}

const key = (clinicId: string) => `attendra.schedule.vets.${clinicId}`;

/** The lanes this person pinned for a clinic, in this browser. Ids no longer on the clinic are dropped. */
export function readChosen(clinicId: string, providers: readonly Pick<Provider, 'id'>[]): string[] {
  try {
    const raw = localStorage.getItem(key(clinicId));
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(ids)) return [];
    const known = new Set(providers.map((p) => p.id));
    return ids.filter((id): id is string => typeof id === 'string' && known.has(id)).slice(0, MAX_CHOSEN);
  } catch {
    return []; // storage off or holding something else: the picker starts empty
  }
}

export function writeChosen(clinicId: string, ids: readonly string[]) {
  try {
    if (ids.length) localStorage.setItem(key(clinicId), JSON.stringify(ids.slice(0, MAX_CHOSEN)));
    else localStorage.removeItem(key(clinicId));
  } catch { /* storage off: the choice lasts for this page only */ }
}

/** "NO" for "Dr. Nkem Okafor": what a narrow lane shows for a name. */
export function initials(name: string) {
  const words = name.replace(/^Dr\.?\s+/i, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || name.slice(0, 2).toUpperCase();
}

// pixels per minute: a 15-minute visit is 26 pixels, so its block is a 24-pixel target (WCAG 2.2, 2.5.8) with a
// gap; an 8 to 5 day is 945 pixels tall
export const PX = 1.75;
/** The least a visit block is drawn: a target anyone can tap. A shorter visit (5 or 10 minutes) still gets this. */
export const MIN_BLOCK = 24;

/** How tall a visit's block is drawn: as long as the visit, less a gap, and never less than a tappable target. */
export const blockHeight = (s: number, e: number) => Math.max((e - s) * PX - 2, MIN_BLOCK);

/**
 * Columns for one lane's visits: blocks whose drawn extents meet (a cancelled visit and the one booked in its
 * place, two booked at once, or short visits stretched to the minimum) form a group, and each in the group gets an
 * equal share of the lane, booked before cancelled, then by start. A visit alone keeps the whole lane.
 */
export function placeBlocks<T extends { status: string }>(items: T[], span: (item: T) => readonly [number, number]): { item: T; column: number; columns: number }[] {
  const drawn = items.map((item) => { const [s, e] = span(item); return { item, top: s * PX, bottom: s * PX + blockHeight(s, e) + 2 }; })
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  const groups: (typeof drawn)[] = [];
  let reach = -Infinity;
  for (const d of drawn) {
    const joins = d.top < reach;
    if (joins) groups.at(-1)!.push(d); else groups.push([d]);
    reach = joins ? Math.max(reach, d.bottom) : d.bottom;
  }
  return groups.flatMap((g) => {
    const ordered = [...g].sort((a, b) => Number(a.item.status === 'cancelled') - Number(b.item.status === 'cancelled') || a.top - b.top);
    return ordered.map((d, column) => ({ item: d.item, column, columns: g.length }));
  });
}
