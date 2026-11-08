// SPDX-License-Identifier: AGPL-3.0-only
import { asE164, type CallOutcome, type EmergencyResult, formatPhone, isE164, roleLabel } from '@attendra/core';

/**
 * What depends on the clinic's country, from its first number: a 12-hour clock in
 * North America and Australia and a 24-hour one elsewhere, and whether a dollar needs
 * saying as US dollars (the model's cost is billed in them). The shell sets it once the
 * clinic's settings arrive; until then the dashboard reads as a US clinic.
 */
const country = { hour12: true, us: true, phoneNumbers: ['+13035550100'] as readonly string[] };
export function setClinicCountry(phoneNumbers: readonly string[]) {
  const first = phoneNumbers[0] ?? '';
  country.us = first.startsWith('+1');
  if (first) country.phoneNumbers = phoneNumbers;
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

/**
 * How an animal's emergency on a call ended (batch 1b): the badge on Calls, and the line on the call page. The words a
 * caller heard come from the engine (emergencyRoute); these are the team's.
 */
export const EMERGENCY_RESULTS: Record<EmergencyResult, { label: string; text: string }> & Record<string, { label: string; text: string } | undefined> = {
  transferred: { label: 'Emergency · put through', text: 'The caller said it was still an emergency and was put through to your team\'s emergency line.' },
  hospital_said: { label: 'Emergency · sent to hospital', text: 'The caller said it was still an emergency and was told to take their pet to your emergency hospital.' },
  hospital_texted: { label: 'Emergency · hospital texted', text: 'The caller said it was still an emergency, was told to take their pet to your emergency hospital, and was texted its address.' },
  urgent_request: { label: 'Emergency · urgent request', text: 'The caller said it was still an emergency, and nobody could be put through: an urgent request is at the top of Requests for your team.' },
  cleared: { label: 'Emergency cleared', text: 'The caller reported a danger sign, then said it was not an emergency now. The call went on, with a note on what they reported for the team.' },
};

/**
 * The one label table for a call's outcome, for every value core's CALL_OUTCOMES has (a test checks each has one): the
 * Calls list, its Outcome filter, the call page, Today and the command palette all read it.
 */
export const OUTCOMES: Record<CallOutcome, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'accent' }> & Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'accent' } | undefined> = {
  booked: { label: 'Booked', tone: 'ok' },
  rescheduled: { label: 'Rescheduled', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'accent' },
  task_created: { label: 'Request for staff', tone: 'warn' },
  transferred: { label: 'Transferred', tone: 'accent' },
  info: { label: 'Answered', tone: 'neutral' },
  emergency: { label: 'Emergency', tone: 'danger' },
  abandoned: { label: 'No action', tone: 'neutral' },
  // the caller never heard the assistant (a silent line): someone to call back
  no_audio: { label: 'Caller heard nothing', tone: 'danger' },
};

/**
 * How a call ended, in plain words, for the call page. The engines' own codes (GPT-Live, gpt-realtime, Vapi) and ours
 * (silent_start: the assistant never spoke, so the call was passed to the front desk or ended, batch 1e); a code we do
 * not know is "Call ended", never the raw code or a log note.
 */
export const CLOSE_REASONS: Record<string, string> = {
  caller_hangup: 'Caller hung up', remote_hangup: 'Caller hung up', 'customer-ended-call': 'Caller hung up',
  agent_hangup: 'Assistant ended the call', 'assistant-ended-call': 'Assistant ended the call', call_ended: 'Call ended',
  transferred: 'Transferred', 'assistant-forwarded-call': 'Transferred',
  ended_by_staff: 'Ended by staff',
  connection_lost: 'Connection dropped',
  transport_failed: 'Phone line did not connect',
  silent_start: 'Assistant never spoke: passed on or ended',
  'silence-timed-out': 'Ended after a long silence', 'exceeded-max-duration': 'Reached the time limit',
};
export function closeReasonLabel(reason: string): string {
  if (CLOSE_REASONS[reason]) return CLOSE_REASONS[reason];
  // the runner's own notes for a drop it saw: "socket closed 1006 before session.closed", "transport failed: busy"
  if (/^socket closed\b/.test(reason)) return CLOSE_REASONS.connection_lost!;
  if (/^transport failed\b/.test(reason)) return CLOSE_REASONS.transport_failed!;
  return 'Call ended';
}

/** The longest the caller waited after speaking, for the call page: "1.8 s" (from core's LONG_WAIT_MS it reads as long). */
export const waitWords = (ms: number) => `${(Math.round(ms / 100) / 10).toFixed(1)} s`;

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
  abusive_caller: 'Abusive caller',
  security_probe: 'Pushed on the rules',
  security_leak: 'Corrected: said how it works',
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
  staff_books: 'booked by the team only, request taken',
  too_far_ahead: 'too far ahead for this visit',
  after_hours: 'closed, request taken instead',
  no_callback_number: 'no number to call back, asked for one',
};

/** Requests, in the words a front desk uses. The API still calls them tasks. */
export const GENDER_LABEL: Record<string, string> = { female: 'Female', male: 'Male', other: 'Other', undisclosed: 'Prefers not to say' };

export const TASK_TYPES: Record<string, string> = { refill: 'Prescription refill', callback: 'Callback', voicemail: 'Voicemail', review: 'New patient to check', follow_up: 'Follow up' };
/** The built-in kinds of request in one order, the same in the Requests filter and in New request. */
export const TASK_KIND_ORDER = ['callback', 'refill', 'voicemail', 'review', 'follow_up'] as const;
/** A request type in the clinic's words: a vet clinic checks a new pet, not a new patient. */
export const taskType = (type: string, patient = 'patient') => (type === 'review' ? `New ${patient} to check` : TASK_TYPES[type] ?? type);
/** A pet's sex, or a person's gender, as the record shows it. */
export const sexLabel = (g: string, pet: boolean) => (pet ? ({ female: 'Female', male: 'Male' } as Record<string, string>)[g] ?? 'Sex unknown' : GENDER_LABEL[g] ?? g);

export const TASK_EXPLAINED: Record<string, string> = {
  refill: 'The patient asked for a refill. Check with the care team, then call them back.',
  callback: 'Someone asked for a person to call them back.',
  voicemail: 'A message the caller left for the team.',
  review: 'The assistant added a new patient on a call. Check their name, date of birth and phone, then confirm them.',
  follow_up: 'A call ended with the caller\'s request unfinished, or the caller upset. Read the call, then get back to them.',
};

/** What a request type means, for a vet clinic or any other. */
export const taskExplained = (type: string, pets: boolean) => (!pets ? TASK_EXPLAINED[type] : ({
  refill: 'An owner asked for a refill. A vet approves or declines it, then the team lets the owner know.',
  review: 'The assistant added a new pet on a call. Check the pet\'s name, kind and birthday, the owner and the phone, then confirm them.',
} as Record<string, string>)[type] ?? TASK_EXPLAINED[type]);

export const TASK_OUTCOMES: Record<string, string> = {
  called_back: 'Called back',
  left_message: 'No answer, left a message',
  refill_sent: 'Refill sent to the pharmacy',
  refill_ready: 'Approved, ready to pick up (texts the caller)',
  refill_declined: 'Not approved, called back',
  not_needed: 'Not needed',
  details_confirmed: 'Details checked and confirmed',
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

/**
 * "8:00 AM" for a local HH:MM (clinic hours, a vet's hours, time off), on the clinic's clock like every other time in
 * the dashboard: 12-hour at a US clinic, "08:00" at a 24-hour one. No time zone arithmetic; "24:00" reads as midnight.
 */
export function localTime(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...hours() }).format(new Date(Date.UTC(2000, 0, 1, h, m)));
}

/** A schedule's hour mark from minutes after midnight: "8 AM" on a 12-hour clock, "08:00" on a 24-hour one. */
export function hourMark(minutes: number) {
  const h = Math.floor(minutes / 60);
  return country.hour12 ? `${((h + 11) % 12) + 1} ${h % 24 < 12 ? 'AM' : 'PM'}` : `${String(h).padStart(2, '0')}:00`;
}

/**
 * A visit type's name wherever it stands as a label (the legend, a calendar block, a vet's card, a list): sentence
 * case, "Wellness exam", whatever the clinic typed. The name is stored as typed, often lowercase because the assistant
 * and the texts say it mid-sentence ("your wellness exam"); Settings edits that stored text.
 */
export const visitTypeName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

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

/** A role as the clinic says it. */
/** A role's name: one source with the permissions (@attendra/core roles.ts). */
export { ROLE_LABEL } from '@attendra/core';

/** What a team member reads as until they write their name (someone added by email alone). */
export const NEW_MEMBER = 'New team member';
/** A team member's name as it shows anywhere: one who has not written theirs yet is "New team member". */
export const personName = (name: string) => name.trim() || NEW_MEMBER;

/** A teammate with their role here: "Jordan Lee (Front desk)"; someone no longer on the team is "a former team member". */
export const personWithRole = (name: string | null, role: string | null) => (name === null ? 'a former team member' : `${personName(name)}${role ? ` (${roleLabel(role)})` : ''}`);

/**
 * Who wrote a request down (REQ-1), after "Added by": the assistant for one from a call, else the teammate with their
 * role here ("Jordan Lee (Front desk)"), or "the team" when Attendra cannot tell.
 */
export const requestCreator = (t: { callId: string | null; createdBy: { name: string | null; role: string | null } | null }) =>
  (t.callId ? 'the assistant' : t.createdBy ? personWithRole(t.createdBy.name, t.createdBy.role) : 'the team');

/**
 * What can happen to a request, in words: its history on the Requests page and the audit log read this one table
 * (audit actions, packages/db). A view is not in a request's history.
 */
export const TASK_HISTORY: Record<string, string> = {
  'task.created.refill': 'Took a refill request',
  'task.created.callback': 'Took a callback request',
  'task.created.voicemail': 'Took a voicemail',
  'task.created.review': 'Added a new patient for the front desk to check',
  'task.created.follow_up': 'Opened a follow-up request for a call left unfinished',
  'task.claimed': 'Claimed a request',
  'task.released': 'Released a request',
  'task.released.override': 'Released someone else\'s request',
  'task.assigned': 'Handed a request to a teammate',
  'task.note.added': 'Added a note to a request',
  'task.planned': 'Changed a request\'s urgency or due day',
  'task.fields.updated': 'Changed the details on a request',
  'task.done': 'Closed a request',
  'task.done.refill_sent': 'Approved a refill (sent to the pharmacy)',
  'task.done.refill_ready': 'Approved a refill (ready to pick up)',
  'task.done.refill_declined': 'Declined a refill',
  'task.reopened': 'Reopened a request',
};

/**
 * A phone number the way people write it: the clinic's own national format for a number in its
 * country ("(505) 555-0142", "020 7946 0123"), the international one for any other. A partial
 * number, as it was given.
 */
export function phone(n: string | null | undefined) {
  return formatPhone(country, n);
}

/** The tap-to-call link for a number: the full international number when it is known, the digits as given otherwise. */
export function telHref(n: string) {
  const e164 = asE164(country, n);
  return `tel:${isE164(e164) ? e164 : n.replace(/[^\d+]/g, '')}`;
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
  'border-l-[var(--visit-5)] bg-[var(--visit-5-soft)]',
  'border-l-[var(--visit-6)] bg-[var(--visit-6-soft)]',
];
/** The tail drawn after a visit for the minutes its type keeps free (cleaning time): its colour, lighter and hatched. */
export const VISIT_TAILS = [
  'border-l-[var(--visit-1)] bg-[repeating-linear-gradient(135deg,var(--visit-1-soft),var(--visit-1-soft)_4px,transparent_4px,transparent_8px)]',
  'border-l-[var(--visit-2)] bg-[repeating-linear-gradient(135deg,var(--visit-2-soft),var(--visit-2-soft)_4px,transparent_4px,transparent_8px)]',
  'border-l-[var(--visit-3)] bg-[repeating-linear-gradient(135deg,var(--visit-3-soft),var(--visit-3-soft)_4px,transparent_4px,transparent_8px)]',
  'border-l-[var(--visit-4)] bg-[repeating-linear-gradient(135deg,var(--visit-4-soft),var(--visit-4-soft)_4px,transparent_4px,transparent_8px)]',
  'border-l-[var(--visit-5)] bg-[repeating-linear-gradient(135deg,var(--visit-5-soft),var(--visit-5-soft)_4px,transparent_4px,transparent_8px)]',
  'border-l-[var(--visit-6)] bg-[repeating-linear-gradient(135deg,var(--visit-6-soft),var(--visit-6-soft)_4px,transparent_4px,transparent_8px)]',
];
export const VISIT_DOTS = ['bg-[var(--visit-1)]', 'bg-[var(--visit-2)]', 'bg-[var(--visit-3)]', 'bg-[var(--visit-4)]', 'bg-[var(--visit-5)]', 'bg-[var(--visit-6)]'];

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

/** Whole days left until a moment, counting part of a day as a day: 0 once it has passed. */
export const daysLeft = (iso: string, now: number) => Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 86_400_000));

/** A request's number as the team says it: R-1042. */
export const requestNumber = (n: number) => `R-${n}`;
