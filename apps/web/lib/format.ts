// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What depends on the clinic's country, from its first number: a 12-hour clock in
 * North America and Australia and a 24-hour one elsewhere, and whether a dollar needs
 * saying as US dollars (the model's cost is billed in them). The shell sets it once the
 * clinic's settings arrive; until then the dashboard reads as a US clinic.
 */
const country = { hour12: true, us: true };
export function setClinicCountry(phoneNumbers: readonly string[]) {
  const first = phoneNumbers[0] ?? '';
  country.us = first.startsWith('+1');
  country.hour12 = country.us || first.startsWith('+61');
}
/** "$0.05" at a US clinic, "US$0.05" anywhere else. */
export const usd = (n: number) => `${country.us ? '$' : 'US$'}${n.toFixed(2)}`;
/** Whether phone numbers are ten digits, as in North America. */
export const tenDigitPhones = () => country.us;
const hours = (): Intl.DateTimeFormatOptions => ({ hour: 'numeric', minute: '2-digit', hour12: country.hour12 });

/** A timestamp in the clinic's own time zone: staff think in clinic time, not browser time. */
/**
 * A moment in the clinic's zone, day first like every other date in the dashboard:
 * "Tue 29 Sep 3:00 PM", or "Tuesday 29 September 2026, 3:00 PM MDT".
 */
export function clinicTime(iso: string, timeZone: string, style: 'short' | 'long' = 'short') {
  if (style === 'short') return shortWhen(iso, timeZone);
  const d = new Date(iso);
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone, ...o }).format(d);
  const zone = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value;
  return `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} ${part({ month: 'long' })} ${part({ year: 'numeric' })}, ${part(hours())}${zone ? ` ${zone}` : ''}`;
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
  task_created: { label: 'Request for staff', tone: 'warn' },
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
  // a confirmation, by how it ended (the call list sends these)
  'commit_pending:booked': 'Booked',
  'commit_pending:rescheduled': 'Rescheduled',
  'commit_pending:cancelled': 'Cancelled',
  'commit_pending:no_clear_yes': 'No clear yes',
  'commit_pending:refused': 'Not changed',
  create_refill_request: 'Refill request',
  create_callback: 'Callback request',
  transfer_call: 'Transfer',
  end_call: 'Ended call',
  get_clinic_info: 'Clinic information',
  search_knowledge: 'Searched clinic documents',
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
  medical_question: 'medical question, not answered',
  patient_busy: 'patient already booked then',
};

/** Requests, in the words a front desk uses. The API still calls them tasks. */
export const TASK_TYPES: Record<string, string> = { refill: 'Prescription refill', callback: 'Callback', voicemail: 'Voicemail', review: 'Needs review' };

export const TASK_EXPLAINED: Record<string, string> = {
  refill: 'The patient asked for a refill. Check with the care team, then call them back.',
  callback: 'Someone asked for a person to call them back.',
  voicemail: 'A message the caller left for the team.',
};

export const TASK_OUTCOMES: Record<string, string> = {
  called_back: 'Called back',
  left_message: 'No answer, left a message',
  refill_sent: 'Refill sent to the pharmacy',
  not_needed: 'Not needed',
};

/** "2 days", "3 hours", "12 minutes": how long something has waited. */
export function waited(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Tue 6 Oct 3:00 PM", in the clinic's zone: the short form the schedule and call page use. */
export function shortWhen(iso: string, timeZone: string) {
  const d = new Date(iso);
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone, ...o }).format(d);
  return `${part({ weekday: 'short' })} ${part({ day: 'numeric' })} ${part({ month: 'short' })} ${part(hours())}`;
}

/** "3:00 PM" in the clinic's zone. */
export const timeOf = (iso: string | Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, ...hours() }).format(new Date(iso));

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
  return name ? `${name} (${timeZone.replaceAll('_', ' ')})` : timeZone;
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

/** Whole years on `today`, the clinic's date (YYYY-MM-DD), not the browser's: a birthday turns over at the clinic's midnight. */
export function age(dateOfBirth: string, today: string) {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let years = ty - y;
  if (tm < m || (tm === m && td < d)) years--;
  return years;
}

/** "just now", "1 minute ago", "7 hours ago", "11 days ago": the one way the dashboard says how long ago something was. */
export function ago(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (m < 1) return 'just now';
  if (m < 60) return unit(m, 'minute');
  if (m < 24 * 60) return unit(Math.round(m / 60), 'hour');
  return unit(Math.round(m / 1440), 'day');
}
