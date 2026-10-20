// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where someone was going when they had to sign in (a page they were on when their
 * session ended, or the setup link in their confirmation email), kept for the length of
 * the tab, so every step of signing in (the code, a new password, two-step setup) ends
 * there instead of on the first clinic. Only a path on this site, never another address.
 */
const KEY = 'attendra.next';

// a browser drops tabs and line breaks from an address ("/\t/x" opens "//x", another site): none anywhere, and no backslash
const plain = (value: string) => [...value].every((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f && c !== '\\');

export function safeNext(value: string | null | undefined): string | null {
  return value && /^\/(?![/\\])/.test(value) && plain(value)
    && !/^\/(sign-in|two-factor|setup-two-factor|change-password|forgot-password|reset-password)\b/.test(value) ? value : null;
}

export function rememberNext(value: string | null | undefined) {
  try {
    const next = safeNext(value);
    if (next) sessionStorage.setItem(KEY, next);
    else sessionStorage.removeItem(KEY);
  } catch { /* storage off: they land on their clinic */ }
}

/** The page to open now, once: it is forgotten as it is used. */
export function takeNext(): string | null {
  try {
    const next = safeNext(sessionStorage.getItem(KEY));
    sessionStorage.removeItem(KEY);
    return next;
  } catch {
    return null;
  }
}
