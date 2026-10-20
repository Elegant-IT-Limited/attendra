import { describe, expect, it, vi } from 'vitest';
import { markSignedOut, rememberNext, safeNext, signedOutOnPurpose, takeNext } from '../lib/next';

describe('where sign-in goes next', () => {
  it('a page of the dashboard, with its query', () => {
    for (const path of ['/c/clinic_1/schedule', '/account', '/profile', '/c/a?b=1#c']) expect(safeNext(path)).toBe(path);
  });

  it('never another site, however the address is written', () => {
    // a browser drops tabs and line breaks, and reads a backslash as a slash: each of these would open evil.example
    for (const path of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/\r\\evil.example', 'https://evil.example', 'evil.example']) {
      expect(safeNext(path), JSON.stringify(path)).toBeNull();
    }
  });

  it('not back to a sign-in step, and nothing at all', () => {
    for (const path of ['/sign-in?next=/x', '/two-factor', '/reset-password?token=t', '', null, undefined]) expect(safeNext(path)).toBeNull();
  });

  it('a chosen sign-out is not a session that ended, until the next sign-in', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    rememberNext('/c/clinic_1/schedule');
    markSignedOut();
    expect(signedOutOnPurpose()).toBe(true);
    expect(takeNext()).toBeNull(); // nothing to come back to after signing out on purpose
    rememberNext(null); // the next sign-in
    expect(signedOutOnPurpose()).toBe(false);
    vi.unstubAllGlobals();
  });
});
