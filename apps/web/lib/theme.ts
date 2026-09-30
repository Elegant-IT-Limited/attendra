// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useCallback, useEffect, useState } from 'react';

import { THEME_KEY, type ThemeChoice } from '@/lib/theme-script';

export type { ThemeChoice };

function resolve(choice: ThemeChoice) {
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** The person's theme: what they chose, what it resolves to now, and a setter that applies and remembers it. */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const c = read();
    setChoice(c);
    setResolved(resolve(c));
    // "system" follows the operating system while the page is open
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (read() !== 'system') return;
      const next = media.matches ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      setResolved(next);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const set = useCallback((c: ThemeChoice) => {
    try { localStorage.setItem(THEME_KEY, c); } catch { /* private mode: the choice lasts for this page only */ }
    const r = resolve(c);
    document.documentElement.dataset.theme = r;
    setChoice(c);
    setResolved(r);
  }, []);

  return { choice, resolved, set };
}
