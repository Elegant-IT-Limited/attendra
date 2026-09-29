// SPDX-License-Identifier: AGPL-3.0-only
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_KEY = 'attendra.theme';

/**
 * Runs in <head> before the page paints. It reads the person's choice from this
 * browser (never from the server: it is a preference, not data) and sets
 * data-theme, falling back to the system setting.
 */
export const THEME_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_KEY}');var d=c==='dark'||((c===null||c==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){document.documentElement.dataset.theme='light';}})();`;

