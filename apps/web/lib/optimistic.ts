// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Schedule, TaskCount, WaitingTasks } from '@attendra/api/contracts';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Shows a change on every screen that holds a copy of it, before the server answers,
 * and gives back how to put them all back if it says no (note 17: a click never waits
 * for the network). Running reads of those screens are stopped first, so an older
 * answer cannot paint over the change; the read after the save brings the truth.
 */
export async function patchCached<T>(queries: QueryClient, queryKey: readonly unknown[], change: (data: T) => T | undefined): Promise<() => void> {
  await queries.cancelQueries({ queryKey });
  const before = queries.getQueriesData<T>({ queryKey });
  for (const [key, data] of before) {
    if (data === undefined) continue;
    const next = change(data);
    if (next !== undefined) queries.setQueryData(key, next);
  }
  return () => { for (const [key, data] of before) queries.setQueryData(key, data); };
}

/** Several of them at once, undone together. */
export async function patchAll(...patches: Promise<() => void>[]): Promise<() => void> {
  const undo = await Promise.all(patches);
  return () => { for (const u of undo) u(); };
}

const isWaiting = (d: unknown): d is WaitingTasks => !!d && Array.isArray((d as WaitingTasks).tasks) && typeof (d as WaitingTasks).total === 'number';
const isCount = (d: unknown): d is TaskCount => !!d && typeof (d as TaskCount).open === 'number' && !('tasks' in (d as object));

/**
 * What a request's action changes outside the Requests list: Today's "waiting for
 * someone" (a claimed, given or closed request leaves it) and the menu's open count (a
 * closed one leaves it).
 */
export function patchRequestElsewhere(queries: QueryClient, clinicId: string, taskId: string, action: string) {
  const taken = action === 'claim' || action === 'assign' || action === 'done';
  return patchAll(
    patchCached<unknown>(queries, ['tasks', clinicId, 'waiting'], (d) => {
      if (!taken || !isWaiting(d) || !d.tasks.some((t) => t.id === taskId)) return undefined;
      return { ...d, tasks: d.tasks.filter((t) => t.id !== taskId), total: Math.max(0, d.total - 1) };
    }),
    patchCached<unknown>(queries, ['tasks', clinicId, 'count'], (d) => (action === 'done' && isCount(d) ? { open: Math.max(0, d.open - 1) } : undefined)),
  );
}

type Appointment = Schedule['appointments'][number];

/**
 * A visit moved or cancelled, on every schedule range on screen (the Schedule, Today)
 * and in its own panel: moved keeps its length, cancelled keeps its place (the grid
 * hides it unless cancelled visits are shown).
 */
export function patchAppointment(queries: QueryClient, clinicId: string, id: string, change: { move: { startsAt: string; providerId: string } } | { cancel: { reason: Appointment['cancelReason'] } }) {
  const apply = (a: Appointment): Appointment => {
    if ('move' in change) {
      const length = Date.parse(a.endsAt) - Date.parse(a.startsAt);
      return { ...a, startsAt: change.move.startsAt, endsAt: new Date(Date.parse(change.move.startsAt) + length).toISOString(), providerId: change.move.providerId };
    }
    return { ...a, status: 'cancelled', cancelReason: change.cancel.reason };
  };
  return patchAll(
    patchCached<Schedule>(queries, ['schedule', clinicId], (s) => (Array.isArray(s?.appointments) && s.appointments.some((a) => a.id === id) ? { ...s, appointments: s.appointments.map((a) => (a.id === id ? apply(a) : a)) } : undefined)),
    patchCached<Appointment>(queries, ['appointment', clinicId, id], (a) => (a?.id === id ? { ...a, ...apply(a) } : undefined)),
  );
}
