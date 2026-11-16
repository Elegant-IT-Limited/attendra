-- Attendra schema v60: the per-call event log (foundation A, 2026-11-17).
--
-- call_events  every event the voice provider sent on a call (OpenAI Realtime, GPT-Live's sideband, Vapi's messages),
--              and the turn gate's and the runner's own decisions (gate.queued, gate.cleared_on_error, runner.nudge):
--              its type, when it came in ms from the call's start, the response and item it belongs to, the call path
--              (engine/flow), and for an `error` only its code and type. Never content: no transcript, no delta, no tool
--              arguments, no audio, no error message. Every text column is id-shaped (no spaces), checked here as in
--              code (core call-events.ts), so a sentence cannot be stored even by mistake.
--              A run of the same delta event for one response is one row: n of them, the last at last_ms.
--              Written in batches by the voice service (every few seconds and at the call's end); kept 7 days, then
--              deleted by the worker's nightly retention job, with an audit row of counts.
--
-- Same Row Level Security as the call's other rows: no clinic set, no row. The application role only reads and adds;
-- the purge deletes on the services' role, in the clinic's scope. Additive: older code ignores it.
create table if not exists call_events (
  id           bigserial primary key,
  clinic_id    text not null,
  call_id      uuid not null references calls(id) on delete cascade,
  path         text not null,
  seq          integer not null,
  at_ms        integer not null,
  type         text not null,
  n            integer not null default 1,
  last_ms      integer,
  response_id  text,
  item_id      text,
  error_code   text,
  error_type   text,
  created_at   timestamptz not null default now(),
  constraint call_events_path check (path ~ '^[a-z0-9_.-]{1,40}/[a-z0-9_.-]{1,40}$'),
  constraint call_events_type check (type ~ '^[a-z0-9_.:-]{1,64}$'),
  constraint call_events_ids check (
    (response_id is null or response_id ~ '^[A-Za-z0-9_.:-]{1,80}$') and (item_id is null or item_id ~ '^[A-Za-z0-9_.:-]{1,80}$')
    and (error_code is null or error_code ~ '^[A-Za-z0-9_.:-]{1,80}$') and (error_type is null or error_type ~ '^[A-Za-z0-9_.:-]{1,80}$')),
  constraint call_events_error_only check ((error_code is null and error_type is null) or type = 'error'),
  constraint call_events_times check (at_ms >= 0 and seq >= 0 and n >= 1 and (last_ms is null or last_ms >= at_ms))
);
create index if not exists call_events_by_call on call_events (clinic_id, call_id, seq);
create index if not exists call_events_by_age on call_events (clinic_id, created_at);

grant select, insert on call_events to attendra_app;
grant usage, select on sequence call_events_id_seq to attendra_app;
alter table call_events enable row level security;
alter table call_events force row level security;
create policy call_events_clinic on call_events using (clinic_id = current_setting('app.clinic_id', true)) with check (clinic_id = current_setting('app.clinic_id', true));

-- Rollback:
--   drop table if exists call_events;
