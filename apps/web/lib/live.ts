// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { LiveCalls } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';

/** The clinic's live calls, every few seconds. Counts and codes; the caller's short name only for roles that may read calls. */
export function useLiveCalls(clinicId: string, enabled = true, every = 5000) {
  return useQuery({ queryKey: ['live', clinicId], queryFn: () => api<LiveCalls>(`/clinics/${clinicId}/live`), refetchInterval: every, enabled });
}

const ALERTS = 'attendra.emergencyAlerts';
const listeners = new Set<() => void>();
const read = () => { try { return localStorage.getItem(ALERTS) === 'on'; } catch { return false; } };

/**
 * Whether this person wants a sound and a notification when an emergency starts on a
 * live call. Off until they turn it on, and kept in this browser only. One setting,
 * shared by the menu that changes it and the watcher that rings.
 */
export function useEmergencyAlerts() {
  const on = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, read, () => false);
  const set = useCallback((next: boolean) => {
    try { localStorage.setItem(ALERTS, next ? 'on' : 'off'); } catch { /* a private window: not kept */ }
    listeners.forEach((l) => l());
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
  }, []);
  return [on, set] as const;
}

/** Two short tones, made in the browser: no sound file to load. */
export function chime() {
  try {
    const ctx = new AudioContext();
    for (const [i, freq] of [880, 660].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.25 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.25 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.25);
      osc.stop(ctx.currentTime + i * 0.25 + 0.25);
    }
  } catch { /* no audio in this browser */ }
}
