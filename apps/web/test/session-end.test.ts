import { describe, expect, it } from 'vitest';
import { endedNote, idleWords, localEnd, reasonForSignedOut, sessionEnd, signedOutUrl, stageAt, WARN_BEFORE_MS, warningText } from '../lib/session-end';

/**
 * When the dashboard's session ends and what the person is told: a warning 10 minutes
 * ahead, a sign-out at the end, and the sign-in page says which end it was.
 */
const MIN = 60_000;
const t0 = Date.parse('2026-11-09T14:00:00.000Z');
const store = (items: Record<string, string>) => ({ getItem: (k: string) => items[k] ?? null });

describe('an idle session', () => {
  const end = sessionEnd({ lastActive: t0, idleMinutes: 120, endsAt: t0 + 11 * 60 * MIN });

  it('ends 120 minutes after the last click or key, before the session\'s own end', () => {
    expect(end).toEqual({ at: t0 + 120 * MIN, why: 'idle' });
  });

  it('is warned 10 minutes ahead, and signed out at 120 minutes', () => {
    expect(WARN_BEFORE_MS).toBe(10 * MIN);
    expect(stageAt(end, t0 + 109 * MIN)).toBe('fine');
    expect(stageAt(end, t0 + 110 * MIN)).toBe('warn');
    expect(stageAt(end, t0 + 119 * MIN)).toBe('warn');
    expect(stageAt(end, t0 + 120 * MIN)).toBe('over');
  });

  it('a click while warned moves the end again', () => {
    const later = sessionEnd({ lastActive: t0 + 115 * MIN, idleMinutes: 120, endsAt: t0 + 11 * 60 * MIN });
    expect(stageAt(later, t0 + 116 * MIN)).toBe('fine');
  });
});

describe('a session that reaches its own end first', () => {
  it('ends at expiresAt, warned 10 minutes ahead', () => {
    const end = sessionEnd({ lastActive: t0, idleMinutes: 120, endsAt: t0 + 30 * MIN });
    expect(end).toEqual({ at: t0 + 30 * MIN, why: 'ended' });
    expect(stageAt(end, t0 + 20 * MIN)).toBe('warn');
    expect(stageAt(end, t0 + 30 * MIN)).toBe('over');
  });

  it('is counted on this browser\'s clock from the seconds left, so a computer clock hours off still ends it on time', () => {
    // the API said 30 minutes were left; this browser's clock reads a day behind the server's, and it does not matter
    const answeredAt = t0 - 24 * 60 * MIN;
    expect(localEnd(answeredAt, 30 * 60)).toBe(answeredAt + 30 * MIN);
    const end = sessionEnd({ lastActive: answeredAt, idleMinutes: 120, endsAt: localEnd(answeredAt, 30 * 60) });
    expect(stageAt(end, answeredAt + MIN)).toBe('fine');
    expect(stageAt(end, answeredAt + 20 * MIN)).toBe('warn');
    // nothing known yet: no end of its own
    expect(localEnd(0, 30 * 60)).toBeNull();
    expect(localEnd(answeredAt, undefined)).toBeNull();
  });

  it('with no end known yet (/me still loading), only the idle minutes count', () => {
    expect(sessionEnd({ lastActive: t0, idleMinutes: 15, endsAt: null })).toEqual({ at: t0 + 15 * MIN, why: 'idle' });
  });
});

describe('what the person reads', () => {
  it('the warning says the time it ends and how to keep it', () => {
    expect(warningText('6:45 PM')).toBe("You'll be signed out at 6:45 PM. Keep working to stay signed in.");
  });

  it('the idle minutes in words, from the server\'s number', () => {
    expect(idleWords(120)).toBe('2 hours');
    expect(idleWords(60)).toBe('1 hour');
    expect(idleWords(90)).toBe('90 minutes');
    expect(idleWords(15)).toBe('15 minutes');
  });

  it('the sign-in page says which end it was, never only that they were signed out', () => {
    expect(endedNote({ idle: '120', expired: null })).toBe('You were signed out after 2 hours without activity. Sign in again to carry on.');
    expect(endedNote({ idle: '15', expired: null })).toBe('You were signed out after 15 minutes without activity. Sign in again to carry on.');
    // an old link, or one not made by the dashboard: still why, without a number it did not get from the server
    expect(endedNote({ idle: '1', expired: null })).toBe('You were signed out after a while without activity. Sign in again to carry on.');
    expect(endedNote({ idle: null, expired: '1' })).toBe('Your session ended. Sign in again to carry on where you were.');
    expect(endedNote({ idle: null, expired: null })).toBeNull();
    for (const note of [endedNote({ idle: '120', expired: null }), endedNote({ idle: null, expired: '1' })]) expect(note).not.toBe('You were signed out. Sign in again to carry on where you were.');
  });

  it('the dashboard sends each end to its own message', () => {
    expect(signedOutUrl('idle', { idleMinutes: 120, here: '/c/x/requests' })).toBe('/sign-in?idle=120');
    expect(signedOutUrl('ended', { idleMinutes: 120, here: '/c/x/requests' })).toBe('/sign-in?expired=1&next=%2Fc%2Fx%2Frequests');
    expect(signedOutUrl('ended', { idleMinutes: 120 })).toBe('/sign-in?expired=1');
  });

  it('a tab told "signed out" by the API works out why: idle in another tab, or the session ended', () => {
    const idleBrowser = store({ 'attendra.activeAt': String(t0), 'attendra.idleMinutes': '120' });
    expect(reasonForSignedOut(t0 + 121 * MIN, idleBrowser)).toEqual({ why: 'idle', idleMinutes: 120 });
    expect(reasonForSignedOut(t0 + 30 * MIN, idleBrowser)).toEqual({ why: 'ended', idleMinutes: 120 });
    expect(reasonForSignedOut(t0, null)).toEqual({ why: 'ended', idleMinutes: null });
  });
});
