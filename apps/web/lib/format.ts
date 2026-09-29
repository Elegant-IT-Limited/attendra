// SPDX-License-Identifier: AGPL-3.0-only

/** A timestamp in the clinic's own time zone: staff think in clinic time, not browser time. */
export function clinicTime(iso: string, timeZone: string, style: 'short' | 'long' = 'short') {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-US', style === 'short'
    ? { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { timeZone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}

export function duration(seconds: number | null) {
  if (seconds === null) return '';
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const OUTCOMES: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'accent' }> = {
  booked: { label: 'Booked', tone: 'ok' },
  rescheduled: { label: 'Rescheduled', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'accent' },
  task_created: { label: 'Task for staff', tone: 'warn' },
  transferred: { label: 'Transferred', tone: 'accent' },
  info: { label: 'Answered', tone: 'neutral' },
  emergency: { label: 'Emergency', tone: 'danger' },
  abandoned: { label: 'No action', tone: 'neutral' },
};

export const TOOLS: Record<string, string> = {
  verify_caller: 'Identity check',
  find_slots: 'Searched openings',
  list_appointments: 'Looked up appointments',
  propose_booking: 'Proposed a time',
  propose_cancellation: 'Proposed a cancellation',
  commit_pending: 'Confirmed change',
  create_refill_request: 'Refill request',
  create_callback: 'Callback request',
  transfer_call: 'Transfer',
  end_call: 'Ended call',
  get_clinic_info: 'Clinic information',
};

/** Refusals the backend returned, in words a front-desk person would use. */
export const REFUSALS: Record<string, string> = {
  identity_required: 'refused: caller not verified',
  not_verified: 'details did not match',
  too_many_attempts: 'identity attempts used up',
  needs_staff: 'two records match, sent to staff',
  no_clear_yes: 'no clear yes, nothing changed',
  not_read_back: 'not read back yet',
  nothing_pending: 'nothing to confirm',
  slot_not_offered: 'time was never offered',
  closed: 'office closed',
};

export const TASK_TYPES: Record<string, string> = { refill: 'Refill request', callback: 'Callback', voicemail: 'Voicemail', review: 'Needs review' };

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Tue 6 Oct 3:00 PM", in the clinic's zone: the short form the schedule and call page use. */
export function shortWhen(iso: string, timeZone: string) {
  const d = new Date(iso);
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone, ...o }).format(d);
  return `${part({ weekday: 'short' })} ${part({ day: 'numeric' })} ${part({ month: 'short' })} ${part({ hour: 'numeric', minute: '2-digit' })}`;
}

/** "3:00 PM" in the clinic's zone. */
export const timeOf = (iso: string | Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** "Tuesday 29 September" for a local YYYY-MM-DD, with no time zone arithmetic. */
export function dayTitle(date: string, style: 'long' | 'short' = 'long') {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(at);
  return style === 'long' ? `${f({ weekday: 'long' })} ${d} ${f({ month: 'long' })}` : `${f({ weekday: 'short' })} ${d} ${f({ month: 'short' })}`;
}

/** "Mountain Time (America/Denver)": shown once per page, so every time on it has a zone. */
export function zoneLabel(timeZone: string) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
  return name ? `${name} (${timeZone.replace('_', ' ')})` : timeZone;
}

export function phone(e164: string | null | undefined) {
  if (!e164) return '';
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** "4 March 1985" from YYYY-MM-DD. */
export function dob(date: string) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(new Date(Date.UTC(y, m - 1, d)))} ${y}`;
}

export const CANCEL_REASONS: Record<string, string> = {
  patient_asked: 'The patient asked',
  clinic_asked: 'The clinic needed to move it',
  booked_in_error: 'Booked by mistake',
  other: 'Something else',
};

/** One colour per visit type, in the order the clinic lists them. Tokens live in globals.css. */
export const VISIT_TONES = [
  'border-l-[var(--visit-1)] bg-[var(--visit-1-soft)]',
  'border-l-[var(--visit-2)] bg-[var(--visit-2-soft)]',
  'border-l-[var(--visit-3)] bg-[var(--visit-3-soft)]',
  'border-l-[var(--visit-4)] bg-[var(--visit-4-soft)]',
];
export const VISIT_DOTS = ['bg-[var(--visit-1)]', 'bg-[var(--visit-2)]', 'bg-[var(--visit-3)]', 'bg-[var(--visit-4)]'];

/** Whole years since a YYYY-MM-DD date of birth, today. */
export function age(dateOfBirth: string, today = new Date()) {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let years = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) years--;
  return years;
}
