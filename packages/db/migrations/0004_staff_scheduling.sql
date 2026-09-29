-- Attendra schema v4: the front desk books, moves and cancels appointments too.
--
-- A booking comes from exactly two places: a call the assistant handled, or a staff
-- member in the dashboard. The check below makes a third, silent source impossible.
-- The note is free text staff type, so it is PHI and stored encrypted like the rest.
-- The cancel reason is a fixed code, never free text, so it can stay in clear.

alter table appointments
  add column created_by_user_id   text,
  add column cancelled_by_user_id text,
  add column cancel_reason        text check (cancel_reason in ('patient_asked', 'clinic_asked', 'booked_in_error', 'other')),
  add column note_enc             text,
  add column updated_at           timestamptz not null default now();

alter table appointments
  add constraint appointments_source check (created_by_call_id is not null or created_by_user_id is not null);

-- The schedule reads one clinic's appointments by time.
create index appointments_schedule on appointments (clinic_id, starts_at);
