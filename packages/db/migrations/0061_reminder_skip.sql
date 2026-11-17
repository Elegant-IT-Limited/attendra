-- Attendra schema v61: why a visit got no reminder text (2026-11-17, texts polish TX0).
--
-- appointments.reminder_skip     why no reminder went, or why it waits: 'no_consent', 'no_number', 'quiet_hours',
--                                'booked_late' (booked under an hour before the visit) or 'too_late' (it could not go
--                                until under an hour before). Written by the worker's reminder job (core
--                                reminderDecision); cleared when the reminder goes, and when the visit is moved.
-- appointments.reminder_skip_at  when the job found it.
--
-- Additive: older code reads none of it.
alter table appointments
  add column if not exists reminder_skip text,
  add column if not exists reminder_skip_at timestamptz;
