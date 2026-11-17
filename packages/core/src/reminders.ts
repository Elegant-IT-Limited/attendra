// SPDX-License-Identifier: AGPL-3.0-only
import { toMinutes } from './time';

/**
 * When a visit's reminder text goes out, and why one did not (texts polish TX0, 2026-11-17).
 *
 * The rule: a reminder goes out as soon as the visit is inside the clinic's "hours before the visit" (Settings >
 * Texting), for any booking (on a call or at the desk) whose owner said yes to texts (on a call, on their record or in an
 * import), while the visit is still more than REMINDER_MIN_LEAD_MINUTES away. A visit booked closer than the clinic's
 * hours gets its reminder at once (it is already inside them); one booked less than an hour before gets none, since the
 * owner has just spoken to the clinic. Quiet hours hold a reminder until they end, if the visit is still more than an
 * hour away then.
 *
 * Before this, the job sent only for visits between 2 and 3 hours away at a setting of 2 (between 2 and 24 at 24): a
 * visit booked, or a setting turned on, after that window opened was never texted, and nothing said why.
 */
export const REMINDER_MIN_LEAD_MINUTES = 60;

/** Why a visit got no reminder, kept on the visit (appointments.reminder_skip, migration 0061). */
export const REMINDER_SKIPS = ['no_consent', 'no_number', 'quiet_hours', 'booked_late', 'too_late'] as const;
export type ReminderSkip = (typeof REMINDER_SKIPS)[number];

/** Whether a clinic-local minute of the day falls in quiet hours, which may run past midnight (20:00 to 08:00). Equal times: none. */
export function inQuietHours(minute: number, from: string, to: string): boolean {
  const f = toMinutes(from);
  const t = toMinutes(to);
  if (f === t) return false;
  return f < t ? minute >= f && minute < t : minute >= f || minute < t;
}

export interface ReminderFacts {
  now: Date;
  startsAt: Date;
  /** When the visit was booked (or moved to this time). */
  bookedAt: Date;
  hoursBefore: number;
  /** The clinic is in its quiet hours now. */
  quietNow: boolean;
  /** The owner said yes to texts, and a number is on file. */
  consent: boolean;
  phone: boolean;
  /** The reason kept on the visit by an earlier run, if any: it explains a reminder that never could go. */
  kept?: ReminderSkip | null;
}

export type ReminderDecision =
  | { action: 'send' }
  /** Not inside the clinic's hours yet: goes out at `dueAt` if nothing changes. */
  | { action: 'later'; dueAt: Date }
  /** Not now. `final`: too close to the visit for one to go at all. */
  | { action: 'skip'; reason: ReminderSkip; final: boolean };

const MIN = 60_000;

/** What the reminder job does with one booked visit that has had no reminder yet. One rule, read by the worker and the visit panel. */
export function reminderDecision(f: ReminderFacts): ReminderDecision {
  const lead = f.startsAt.getTime() - f.now.getTime();
  const dueAt = new Date(f.startsAt.getTime() - f.hoursBefore * 3_600_000);
  if (lead > f.hoursBefore * 3_600_000) return { action: 'later', dueAt };
  if (lead <= REMINDER_MIN_LEAD_MINUTES * MIN) {
    // too close now: say why it never went
    if (f.startsAt.getTime() - f.bookedAt.getTime() <= REMINDER_MIN_LEAD_MINUTES * MIN) return { action: 'skip', reason: 'booked_late', final: true };
    if (!f.consent) return { action: 'skip', reason: 'no_consent', final: true };
    if (!f.phone) return { action: 'skip', reason: 'no_number', final: true };
    return { action: 'skip', reason: f.kept ?? (f.quietNow ? 'quiet_hours' : 'too_late'), final: true };
  }
  if (!f.consent) return { action: 'skip', reason: 'no_consent', final: false };
  if (!f.phone) return { action: 'skip', reason: 'no_number', final: false };
  if (f.quietNow) return { action: 'skip', reason: 'quiet_hours', final: false };
  return { action: 'send' };
}

/** "40 minutes", "1 hour", "2 hours 5 minutes". */
export function spanWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const part = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (!h) return part(m, 'minute');
  return m ? `${part(h, 'hour')} ${part(m, 'minute')}` : part(h, 'hour');
}

/**
 * The words on the visit for a reminder that did not go (or has not yet): "No reminder: booked 40 minutes before the
 * visit". `final` false: the reason holds it for now ("Reminder waits: quiet hours").
 */
export function reminderSkipLine(reason: ReminderSkip, v: { startsAt: Date; bookedAt: Date; final: boolean }): string {
  const lead = spanWords(v.startsAt.getTime() - v.bookedAt.getTime());
  if (!v.final) {
    if (reason === 'quiet_hours') return 'Reminder waits: quiet hours. It goes out when they end, if the visit is more than an hour away then.';
    if (reason === 'no_consent') return 'No reminder yet: no texts consent. It goes out if the owner says yes before the visit.';
    if (reason === 'no_number') return 'No reminder yet: no number on file to text.';
  }
  switch (reason) {
    case 'booked_late': return `No reminder: booked ${lead} before the visit.`;
    case 'no_consent': return 'No reminder: no texts consent.';
    case 'no_number': return 'No reminder: no number on file to text.';
    case 'quiet_hours': return 'No reminder: quiet hours until less than an hour before the visit.';
    case 'too_late': return 'No reminder: it could not go until less than an hour before the visit.';
  }
}

/** A visit's reminder as the visit panel shows it; null when the "Texted" line (or nothing) says it all. */
export type ReminderState =
  | { state: 'due'; dueAt: Date | null }
  | { state: 'skipped'; reason: ReminderSkip; final: boolean }
  | { state: 'off' }
  | { state: 'not_sent' };

/**
 * Where a visit's reminder is, for the visit panel: the same rule the worker sends by (reminderDecision), read now.
 * `kept` is the reason the worker stored; `smsStatus` the reminder text's status once one was tried.
 */
export function reminderState(v: {
  now: Date; booked: boolean; startsAt: Date; bookedAt: Date; reminderSentAt: Date | null; kept: ReminderSkip | null; smsStatus: string | null;
  reminders: { enabled: boolean; hoursBefore: number }; quietNow: boolean; consent: boolean; phone: boolean;
}): ReminderState | null {
  if (v.reminderSentAt) return v.smsStatus === 'not_sent' || v.smsStatus === 'failed' || v.smsStatus === 'undelivered' ? { state: 'not_sent' } : null;
  const ahead = v.booked && v.startsAt.getTime() > v.now.getTime();
  if (!ahead) return v.kept ? { state: 'skipped', reason: v.kept, final: true } : null;
  if (!v.reminders.enabled) return { state: 'off' };
  const d = reminderDecision({ now: v.now, startsAt: v.startsAt, bookedAt: v.bookedAt, hoursBefore: v.reminders.hoursBefore, quietNow: v.quietNow, consent: v.consent, phone: v.phone, kept: v.kept });
  if (d.action === 'skip') return { state: 'skipped', reason: d.reason, final: d.final };
  if (d.action === 'later') {
    // said early: a reminder that cannot go when its time comes
    if (!v.consent) return { state: 'skipped', reason: 'no_consent', final: false };
    if (!v.phone) return { state: 'skipped', reason: 'no_number', final: false };
    return { state: 'due', dueAt: d.dueAt };
  }
  return { state: 'due', dueAt: null };
}

/** The visit panel's words for a reminder state; `time` formats an instant in the clinic's time zone. */
export function reminderStateLine(r: ReminderState, v: { startsAt: Date; bookedAt: Date }, time: (d: Date) => string): string {
  switch (r.state) {
    case 'due': return r.dueAt ? `Reminder goes out around ${time(r.dueAt)}.` : 'Reminder goes out in the next few minutes.';
    case 'off': return 'No reminder: reminders are off in Settings > Texting.';
    case 'not_sent': return 'No reminder: the text was not sent. Texts below says why.';
    case 'skipped': return reminderSkipLine(r.reason, { ...v, final: r.final });
  }
}
