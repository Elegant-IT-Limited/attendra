-- Attendra schema v56: Vapi as a location's backup voice engine (batch 6).
--
-- vapi_secrets          each location's own secret, which its Vapi assistant sends with every request to the voice
--                       service's Vapi route (x-vapi-secret). Kept twice: encrypted with the deployment's data key (the API
--                       sends it again whenever it updates the assistant) and as a keyed hash (the voice service checks a
--                       request against it without decrypting). One row per location; it goes with the clinic.
-- vapi_live_calls       the Vapi calls going on now, across every location, from Vapi's status messages: Vapi's limit on
--                       calls at the same moment is per subscription, not per clinic. Ids and times only, no clinic, no
--                       number. A call with no end heard is counted for two hours at most (core VAPI_CALL_STALE_MS).
-- vapi_concurrency_days the most Vapi calls live at once on each day (UTC), and when the 70% alert went out that day.
--
-- Additive: older code reads none of it.
create table if not exists vapi_secrets (
  clinic_id   text primary key references clinics(id) on delete cascade,
  secret_enc  text not null,
  secret_hash text not null,
  created_at  timestamptz not null default now()
);
grant select, insert, update, delete on vapi_secrets to attendra_app;
alter table vapi_secrets enable row level security;
alter table vapi_secrets force row level security;
create policy vapi_secrets_clinic on vapi_secrets using (clinic_id = current_setting('app.clinic_id', true)) with check (clinic_id = current_setting('app.clinic_id', true));

create table if not exists vapi_live_calls (
  vapi_call_id text primary key,
  started_at   timestamptz not null,
  ended_at     timestamptz
);
create index if not exists vapi_live_calls_open on vapi_live_calls (started_at) where ended_at is null;

create table if not exists vapi_concurrency_days (
  day        date primary key,
  peak       integer not null default 0,
  alerted_at timestamptz,
  constraint vapi_concurrency_days_peak check (peak >= 0)
);

-- Rollback:
--   drop table if exists vapi_concurrency_days, vapi_live_calls, vapi_secrets;
