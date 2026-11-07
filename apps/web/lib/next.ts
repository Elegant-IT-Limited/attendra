// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where someone was going when they had to sign in (a page they were on when their
 * session ended, or the setup link in their confirmation email), kept for the length of
 * the tab, so every step of signing in (the code, a new password, two-step setup) ends
 * there instead of on the first clinic. Only a path on this site, never another address.
 */
const KEY = 'attendra.next';
const OUT = 'attendra.signedOut';
const ASKED = 'attendra.askedName';
const USER = 'attendra.user';

// a browser drops tabs and line breaks from an address ("/\t/x" opens "//x", another site): none anywhere, and no backslash
const plain = (value: string) => [...value].every((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f && c !== '\\');

export function safeNext(value: string | null | undefined): string | null {
  return value && /^\/(?![/\\])/.test(value) && plain(value)
    && !/^\/(sign-in|two-factor|setup-two-factor|change-password|forgot-password|reset-password)\b/.test(value) ? value : null;
}

/** Who is signed in, in this tab, as /me last said: a page remembered when their session ended is theirs only. */
export function noteUser(userId: string) {
  try { sessionStorage.setItem(USER, userId); } catch { /* storage off */ }
}

/**
 * Remembers where to go after signing in. A page remembered because a session ended is
 * bound to the person whose session it was: someone else signing in at that computer
 * goes to their own clinic, not to a page of a clinic they cannot open ("Clinic not
 * found"). A link someone followed while signed out (an invitation) is for whoever signs in.
 */
export function rememberNext(value: string | null | undefined, opts: { fromEndedSession?: boolean } = {}) {
  try {
    sessionStorage.removeItem(OUT);
    const next = safeNext(value);
    const user = opts.fromEndedSession ? sessionStorage.getItem(USER) : null;
    if (next) sessionStorage.setItem(KEY, JSON.stringify({ path: next, user }));
    else sessionStorage.removeItem(KEY);
  } catch { /* storage off: they land on their clinic */ }
}

/** The page to open now for this person, once: it is forgotten as it is used, and dropped when it was someone else's. */
export function takeNext(userId?: string): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) return null;
    let kept: { path?: string; user?: string | null };
    try { kept = JSON.parse(raw) as typeof kept; } catch { kept = { path: raw, user: null }; }
    if (kept.user && userId && kept.user !== userId) return null;
    return safeNext(kept.path);
  } catch {
    return null;
  }
}

/**
 * Signed out on purpose (the Sign out button, or the dashboard signing out by itself), and
 * where to: plain sign-in after the button, sign-in with the reason after an idle or ended
 * session. A request that answers "signed out" meanwhile goes to the same page, never to a
 * different note.
 */
export function markSignedOut(to = '/sign-in') {
  try {
    sessionStorage.setItem(OUT, to);
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(ASKED);
  } catch { /* storage off: they see the session-ended note, which is still true */ }
}

/** Where a sign-out on purpose was going; null when there was none. */
export function signedOutTo(): string | null {
  try {
    const to = sessionStorage.getItem(OUT);
    if (!to) return null;
    return to.startsWith('/sign-in') ? to : '/sign-in';
  } catch {
    return null;
  }
}

export const signedOutOnPurpose = () => signedOutTo() !== null;

/**
 * Whether to open Your profile now for someone who has not written their name yet: once
 * per sign-in, in this tab. Skipping it is their choice; the next sign-in asks again.
 */
export function askForNameOnce(): boolean {
  try {
    if (sessionStorage.getItem(ASKED) === '1') return false;
    sessionStorage.setItem(ASKED, '1');
    return true;
  } catch {
    return false;
  }
}

/** Every Sign out button: the session ends, and the sign-in page opens. */
export function signOutAndLeave(signOut: () => Promise<unknown>) {
  markSignedOut();
  void signOut().catch(() => {}).finally(() => window.location.assign('/sign-in'));
}

