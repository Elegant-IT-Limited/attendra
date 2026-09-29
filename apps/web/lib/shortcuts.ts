// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef } from 'react';

/** The keys, as the shortcuts dialog lists them. */
export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['⌘', 'K'], label: 'Search and jump (Ctrl+K on Windows)' },
  { keys: ['G', 'T'], label: 'Go to Today' },
  { keys: ['G', 'S'], label: 'Go to Schedule' },
  { keys: ['G', 'P'], label: 'Go to Patients' },
  { keys: ['G', 'R'], label: 'Go to Requests' },
  { keys: ['G', 'C'], label: 'Go to Calls' },
  { keys: ['N'], label: 'New booking' },
  { keys: ['?'], label: 'Show these shortcuts' },
];

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

/**
 * Global keys. Letters only count when nothing is being typed and no dialog is
 * open, so a note that says "g" goes nowhere. Cmd+K or Ctrl+K works everywhere.
 */
export function useShortcuts(on: { palette: () => void; go: (key: string) => void; newBooking: () => void; help: () => void }) {
  const handlers = useRef(on);
  handlers.current = on;
  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); handlers.current.palette(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('[role=dialog]')) return;
      const k = e.key.toLowerCase();
      if (pendingG && Date.now() - pendingG < 1200) {
        pendingG = 0;
        if ('tsprc'.includes(k)) { e.preventDefault(); handlers.current.go(k); }
        return;
      }
      if (k === 'g') { pendingG = Date.now(); return; }
      if (k === 'n') { e.preventDefault(); handlers.current.newBooking(); return; }
      if (e.key === '?') { e.preventDefault(); handlers.current.help(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
