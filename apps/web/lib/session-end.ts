// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When the dashboard's session ends, and what the person is told about it: before (a
 * warning 10 minutes ahead, while they can still keep it) and after (the sign-in page
 * says why, never only that they were signed out). One place for both, so the warning,
 * the sign-out and the sign-in page always agree.
 *
 * Two things end a session: the deployment's idle minutes (no click or key in any tab;
 * the dashboard signs out) and the session's own end, 12 hours after it was last
 * renewed by the API. The idle minutes always come first while a tab is open; the
 * other end is what a person meets after a night away.
 */

/** How long before an end the dashboard warns. */
export const WARN_BEFORE_MS = 10 * 60_000;
/** The last click or key in any tab of the dashboard (they share one session). */
export const ACTIVE_AT_KEY = 'attendra.activeAt';
/** The deployment's idle minutes, kept for a tab that is told it was signed out (a 401) without /me. */
export const IDLE_MINUTES_KEY = 'attendra.idleMinutes';

export type EndReason = 'idle' | 'ended';
export interface SessionEnd { at: number; why: EndReason }

/** The first of the two ends: idle minutes after the last activity, or the session's own end. */
export function sessionEnd({ lastActive, idleMinutes, expiresAt }: { lastActive: number; idleMinutes: number; expiresAt?: string | null }): SessionEnd {
  const idle = lastActive + idleMinutes * 60_000;
  const expires = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return Number.isFinite(expires) && expires < idle ? { at: expires, why: 'ended' } : { at: idle, why: 'idle' };
}

/** Nothing to say yet, the warning, or past the end. */
export function stageAt(end: SessionEnd, now: number): 'fine' | 'warn' | 'over' {
  if (now >= end.at) return 'over';
  return now >= end.at - WARN_BEFORE_MS ? 'warn' : 'fine';
}

/** "2 hours", "1 hour", "90 minutes", "15 minutes": the idle minutes as a person says them. */
export function idleWords(minutes: number) {
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** The warning, with the time of the end already in the clinic's words ("6:45 PM"). */
export const warningText = (time: string) => `You'll be signed out at ${time}. Keep working to stay signed in.`;

/** The deployment's idle minutes go from 5 to 720: anything else in a link is not one of ours. */
const idleMinutesFrom = (value: string | null) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 5 && n <= 720 ? n : null;
};

/** Where the dashboard goes when it signs out by itself: the sign-in page, told why. */
export function signedOutUrl(why: EndReason, { idleMinutes, here }: { idleMinutes: number; here?: string | null }) {
  if (why === 'idle') return `/sign-in?idle=${idleMinutes}`;
  return `/sign-in?expired=1${here ? `&next=${encodeURIComponent(here)}` : ''}`;
}

/**
 * Why a page that was told "signed out" by the API was: idle minutes passed in this
 * browser (another tab signed out), or else the session itself ended.
 */
export function reasonForSignedOut(now: number, storage: Pick<Storage, 'getItem'> | null): { why: EndReason; idleMinutes: number | null } {
  const activeAt = Number(storage?.getItem(ACTIVE_AT_KEY)) || 0;
  const idleMinutes = idleMinutesFrom(storage?.getItem(IDLE_MINUTES_KEY) ?? null);
  if (activeAt && idleMinutes && now - activeAt >= idleMinutes * 60_000) return { why: 'idle', idleMinutes };
  return { why: 'ended', idleMinutes };
}

/** What the sign-in page says about how the last session ended, from its link; null when nothing ended. */
export function endedNote({ idle, expired }: { idle: string | null; expired: string | null }): string | null {
  if (idle !== null) {
    const minutes = idleMinutesFrom(idle);
    return `You were signed out after ${minutes ? idleWords(minutes) : 'a while'} without activity. Sign in again to carry on.`;
  }
  if (expired !== null) return 'Your session ended. Sign in again to carry on where you were.';
  return null;
}
