-- Attendra schema v29: texts linked to what they are about, opt-outs, the call's language.
--
-- Each text row now says which call, pet or patient, request and visit it was about,
-- so staff can see whether it went. A text refused before it reached the carrier is
-- kept as status 'not_sent' with the reason. No number is stored, only its hash.

alter table sms_messages
  add column if not exists kind text not null default 'auto',   -- 'auto' (confirmation), 'asked' (in-call, after a spoken yes), 'reminder'
  add column if not exists call_id uuid,
  add column if not exists patient_id uuid,
  add column if not exists task_id uuid,
  add column if not exists appointment_id uuid,
  add column if not exists language text not null default 'en',
  add column if not exists consent_at_ms integer,              -- where on the call the yes was said (kind 'asked')
  add column if not exists error_code text,                    -- the carrier's error code, when it refused the text
  add column if not exists failure_reason text,                -- 'opted_out' | 'rate_limited' | 'no_number' | 'texting_off' | 'unregistered' | 'carrier'
  add column if not exists sent_at timestamptz,
  add column if not exists delivered_at timestamptz;
create index if not exists sms_messages_call on sms_messages (clinic_id, call_id) where call_id is not null;
create index if not exists sms_messages_task on sms_messages (clinic_id, task_id) where task_id is not null;
create index if not exists sms_messages_patient on sms_messages (clinic_id, patient_id) where patient_id is not null;
create index if not exists sms_messages_appointment on sms_messages (clinic_id, appointment_id) where appointment_id is not null;
create index if not exists sms_messages_to_recent on sms_messages (clinic_id, to_hash, created_at);

-- A number's standing with this clinic. One row per number; the latest keyword wins.
create table if not exists sms_opt_outs (
  clinic_id text not null references clinics(id),
  to_hash   text not null,
  status    text not null check (status in ('opted_out', 'opted_in')),
  source    text not null check (source in ('keyword', 'carrier', 'staff')),
  at        timestamptz not null default now(),
  primary key (clinic_id, to_hash)
);
alter table sms_opt_outs enable row level security;
alter table sms_opt_outs force row level security;
create policy sms_opt_outs_clinic on sms_opt_outs
  using (clinic_id = current_setting('app.clinic_id', true))
  with check (clinic_id = current_setting('app.clinic_id', true));
grant select, insert, update on sms_opt_outs to attendra_app;

-- The language the call ended in, so a later text (ready to pick up) is in it.
alter table calls add column if not exists language text;
