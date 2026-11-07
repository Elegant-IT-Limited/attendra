// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * Which cached screens each kind of change makes stale. Keys are the first part of a
 * query key. An open patient record and a patient search are left alone: reading them
 * again writes an audit row for a view nobody made, so they refresh when used.
 */
export const STALE: Record<string, string[]> = {
  requests: ['tasks', 'overview'],
  schedule: ['schedule', 'appointment', 'slots', 'overview', 'cancelled', 'schedule-conflicts'],
  patients: ['patients', 'tasks'],
  calls: ['calls', 'call', 'overview', 'live'],
  settings: ['settings', 'doctors', 'slots'],
  // a role changed here: who you are (the menu and every button), the team list and "Assign to"
  team: ['me', 'members', 'assignees'],
  // a document queued, indexed or failed
  knowledge: ['knowledge'],
  // a text sent, delivered or failed: its line on the call and the record
  texts: ['texts'],
  // a call started, ended, or moved on: "Live now" and the test call bar
  live: ['live'],
  // this person's own invitations and roles, at any location: the banner, the start page, the switcher
  me: ['me'],
};
/** Keys about the person, not a clinic: ['me'], ['me', 'invitations']. Every other key's second part is its clinic. */
const PERSON = new Set(['me']);

/** At most one refetch of a screen per this many milliseconds, however many changes arrive. */
export const COALESCE_MS = 2_000;
/**
 * Screens the stream keeps current still read on their own this often, in case a notice
 * never arrives (a proxy that held it, a laptop that slept through a reconnect).
 */
export const SAFETY_POLL_MS = 2 * 60_000;
/** The same, in words, for "it tries again every …": never a second copy of the number. */
export const SAFETY_POLL_WORDS = `${SAFETY_POLL_MS / 60_000} minutes`;

/** Whether a cached query is one of these keys, for this clinic (or about the person). */
export const matcher = (clinicId: string | null, keys: Set<string>) => (q: { queryKey: readonly unknown[] }) => {
  const [root, scope] = q.queryKey;
  if (typeof root !== 'string' || !keys.has(root)) return false;
  return PERSON.has(root) || (clinicId !== null && scope === clinicId);
};

/**
 * What one message from the stream makes stale: the keys of its topics, or for '*'
 * (anything may have changed) the keys of every topic. Still never a patient record or
 * a search, which are audited when read.
 */
export function staleKeys(topics: readonly string[] | '*'): Set<string> {
  const all = topics === '*' || topics.includes('*');
  return new Set((all ? Object.keys(STALE) : topics).flatMap((t) => STALE[t] ?? []));
}

/**
 * Keeps every open screen current without a refresh. The API says which kinds of
 * thing changed (a request taken, a booking, a patient added, a doctor's hours, a call
 * going on, an invitation to this person), and the screens showing them read again
 * through their usual routes.
 *
 * A busy clinic sends many changes a minute, and every open tab used to read every
 * screen again on each one. Changes are gathered and applied at most once every
 * 2 seconds; only screens in view read again (a cached screen nobody is looking at is
 * marked stale and reads when it is opened); a hidden tab reads nothing until it is
 * shown again.
 *
 * When the connection drops, the browser comes back on its own with the id of the last
 * message, and the first message back says what was missed: those screens read again,
 * or all of them when the gap cannot be told (the API restarted, or lost its own
 * notices for a while). A reconnect that missed nothing reads nothing.
 *
 * `clinicId` null: a page outside any clinic (the start page, the profile), which hears
 * only the person's own changes.
 */
export function useChanges(clinicId: string | null, enabled = true) {
  const queries = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const url = clinicId ? `/api/v1/clinics/${clinicId}/changes` : '/api/v1/me/changes';
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const apply = () => {
      const keys = new Set(pending);
      pending.clear();
      timer = null;
      last = Date.now();
      invalidate(queries, clinicId, keys);
    };
    const take = (topics: readonly string[] | '*') => {
      for (const k of staleKeys(topics)) pending.add(k);
      if (!pending.size || timer) return;
      timer = setTimeout(apply, Math.max(0, last + COALESCE_MS - Date.now()));
    };
    const source = new EventSource(url, { withCredentials: true });
    source.addEventListener('ready', (e) => {
      let missed: string[] | '*';
      try { missed = (JSON.parse((e as MessageEvent<string>).data) as { missed: string[] | '*' }).missed; } catch { return; }
      if (missed === '*' || missed.length) take(missed);
    });
    source.addEventListener('change', (e) => {
      let topics: string[];
      try { topics = (JSON.parse((e as MessageEvent<string>).data) as { topics: string[] }).topics; } catch { return; }
      take(topics);
    });
    return () => { source.close(); if (timer) clearTimeout(timer); };
  }, [clinicId, enabled, queries]);
}

/** The screens a clinic's tab shows. */
export const useClinicChanges = (clinicId: string, enabled = true) => useChanges(clinicId, enabled);

function invalidate(queries: QueryClient, clinicId: string | null, keys: Set<string>) {
  // in a hidden tab, marked stale only: the dashboard reads stale screens when the tab is shown again (refetchOnWindowFocus)
  void queries.invalidateQueries({ predicate: matcher(clinicId, keys), refetchType: document.hidden ? 'none' : 'active' });
}
