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
