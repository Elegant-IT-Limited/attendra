-- Attendra schema v6: the front desk writes on requests, and closes them with an outcome.
--
-- A note is free text about a patient ("left a voicemail, pharmacy is closed"), so its
-- body is encrypted like the other PHI columns. Notes are added, never edited, so the
-- application role can insert and read them and nothing else. The outcome is a fixed
-- code, which is what a report on the queue needs and what cannot carry PHI.

create table task_notes (
  id             bigserial primary key,
  clinic_id      text not null references clinics(id),
  task_id        uuid not null references tasks(id),
  author_user_id text not null,
  body_enc       text not null,
  created_at     timestamptz not null default now()
);
create index task_notes_task on task_notes (clinic_id, task_id, created_at);

alter table task_notes enable row level security;
alter table task_notes force row level security;
create policy task_notes_clinic on task_notes
  using (clinic_id = current_setting('app.clinic_id', true))
  with check (clinic_id = current_setting('app.clinic_id', true));
grant select, insert on task_notes to attendra_app;
grant usage, select on sequence task_notes_id_seq to attendra_app;

alter table tasks
  add column outcome text check (outcome in ('called_back', 'left_message', 'refill_sent', 'not_needed')),
  add column assigned_by_user_id text;
