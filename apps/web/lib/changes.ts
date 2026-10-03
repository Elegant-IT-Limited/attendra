// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** Which cached screens each kind of change makes stale. Keys are the first part of a query key. */
const STALE: Record<string, string[]> = {
  requests: ['tasks', 'overview', 'patient'],
  schedule: ['schedule', 'appointment', 'slots', 'overview', 'patient', 'cancelled'],
  patients: ['patient', 'patient-search', 'patients', 'tasks', 'schedule'],
  calls: ['calls', 'call', 'overview', 'live', 'patient'],
  settings: ['settings', 'doctors', 'slots'],
};

/**
 * Keeps every open screen current without a refresh. The API says which kinds of
 * thing changed in the clinic (a request taken, a booking, a patient added, a doctor's
 * hours), and the screens showing them read again through their usual routes. If the
 * stream drops, the browser reconnects on its own; until it does, screens still
 * refresh on their own timers.
 */
export function useClinicChanges(clinicId: string, enabled = true) {
  const queries = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const source = new EventSource(`/api/v1/clinics/${clinicId}/changes`, { withCredentials: true });
    source.addEventListener('change', (e) => {
      let topics: string[];
      try { topics = (JSON.parse((e as MessageEvent<string>).data) as { topics: string[] }).topics; } catch { return; }
      const stale = new Set(topics.flatMap((t) => STALE[t] ?? []));
      void queries.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && stale.has(q.queryKey[0]) && q.queryKey[1] === clinicId });
    });
    return () => source.close();
  }, [clinicId, enabled, queries]);
}
