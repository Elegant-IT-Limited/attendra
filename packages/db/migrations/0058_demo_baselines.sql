-- Attendra schema v58: a demo clinic's baseline (2026-11-16).
--
-- demo_baselines  one row per demo clinic: the operational data it was set up with ("Set demo baseline now" in the back
--                 office), which the nightly reset (03:30 clinic time) and "Reset demo now" restore exactly. data_enc
--                 is the snapshot of the clinic's own rows in patients (pets with their owners), patient_search_keys,
--                 appointments, tasks (requests) and task_notes, as JSON encrypted with the data key; the encrypted
--                 columns inside it stay as they were stored. counts is how many rows of each, numbers only.
--                 last_reset_at / last_reset_counts: the newest reset and what it changed, numbers only.
--                 Settings, vets, visit types, common questions, documents, calls and transcripts are never in it.
--
-- Same Row Level Security as the clinic's other rows: no clinic set, no row. Goes with the clinic. Additive: older
-- code reads none of it.
create table if not exists demo_baselines (
  clinic_id          text primary key references clinics(id) on delete cascade,
  taken_at           timestamptz not null,
  taken_by           text not null,
  data_enc           text not null,
  counts             jsonb not null,
  last_reset_at      timestamptz,
  last_reset_counts  jsonb
);
grant select, insert, update, delete on demo_baselines to attendra_app;
alter table demo_baselines enable row level security;
alter table demo_baselines force row level security;
create policy demo_baselines_clinic on demo_baselines using (clinic_id = current_setting('app.clinic_id', true)) with check (clinic_id = current_setting('app.clinic_id', true));

-- Rollback:
--   drop table if exists demo_baselines;
