// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * Which cached screens each kind of change makes stale. Keys are the first part of a
 * query key. An open patient record and a patient search are left alone: reading them
 * again writes an audit row for a view nobody made, so they refresh when used.
 */
const STALE: Record<string, string[]> = {
  requests: ['tasks', 'overview'],
  schedule: ['schedule', 'appointment', 'slots', 'overview', 'cancelled'],
  patients: ['patients', 'tasks'],
  calls: ['calls', 'call', 'overview', 'live'],
  settings: ['settings', 'doctors', 'slots'],
};

/** At most one refetch of a screen per this many milliseconds, however many changes arrive. */
export const COALESCE_MS = 2_000;

/**
 * Keeps every open screen current without a refresh. The API says which kinds of
 * thing changed in the clinic (a request taken, a booking, a patient added, a doctor's
 * hours), and the screens showing them read again through their usual routes. If the
 * stream drops, the browser reconnects on its own; until it does, screens still
 * refresh on their own timers.
 *
 * A busy clinic sends many changes a minute, and every open tab used to read every
 * screen again on each one. Changes are gathered and applied at most once every
 * 2 seconds; only screens in view read again (a cached screen nobody is looking at
 * is marked stale and reads when it is opened); a hidden tab reads nothing until it
 * is shown again.
 */
export function useClinicChanges(clinicId: string, enabled = true) {
  const queries = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const matches = (keys: Set<string>) => (q: { queryKey: readonly unknown[] }) => typeof q.queryKey[0] === 'string' && keys.has(q.queryKey[0]) && q.queryKey[1] === clinicId;
    const apply = () => {
      const stale = new Set(pending);
      pending.clear();
      timer = null;
      last = Date.now();
      // in a hidden tab, marked stale only: the dashboard reads stale screens when the tab is shown again (refetchOnWindowFocus)
      void queries.invalidateQueries({ predicate: matches(stale), refetchType: document.hidden ? 'none' : 'active' });
    };
    const source = new EventSource(`/api/v1/clinics/${clinicId}/changes`, { withCredentials: true });
    source.addEventListener('change', (e) => {
      let topics: string[];
      try { topics = (JSON.parse((e as MessageEvent<string>).data) as { topics: string[] }).topics; } catch { return; }
      for (const key of topics.flatMap((t) => STALE[t] ?? [])) pending.add(key);
      if (!pending.size || timer) return;
      timer = setTimeout(apply, Math.max(0, last + COALESCE_MS - Date.now()));
    });
    return () => { source.close(); if (timer) clearTimeout(timer); };
  }, [clinicId, enabled, queries]);
}
