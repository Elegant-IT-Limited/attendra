-- Attendra schema v45: which engine answered each call, how it ran, and what it cost (batch 1a).
--
-- A call is no longer only an OpenAI GPT-Live session: the Realtime models answer some, and a
-- third engine (Vapi) may later. Kept on the call row:
--   engine             'gpt-live' | 'gpt-realtime' | 'vapi' (null on calls closed before this)
--   engine_session_id  the engine's own id for the call (OpenAI's session or call id today);
--                      openai_session_id stays for one release, then goes
--   voice_flow         'planner' (one hand-off per turn to the planner) or 'tools' (the voice
--                      calls the tools API directly), per clinic, set by the operator
-- The calls already on file are filled from their session id: GPT-Live ids start live_, the
-- Realtime API's rtc_. calls forces its row policy on every role, so the fill runs clinic by
-- clinic, as 0041 did.
alter table calls add column if not exists engine text;
alter table calls add column if not exists engine_session_id text;
alter table calls add column if not exists voice_flow text;
alter table calls add constraint calls_engine_known check (engine is null or engine in ('gpt-live', 'gpt-realtime', 'vapi'));
alter table calls add constraint calls_voice_flow_known check (voice_flow is null or voice_flow in ('planner', 'tools'));

do $$
declare c text;
begin
  for c in select id from clinics loop
    perform set_config('app.clinic_id', c, true);
    update calls set
      engine_session_id = coalesce(engine_session_id, openai_session_id),
      engine = coalesce(engine, case when openai_session_id like 'rtc_%' then 'gpt-realtime' when openai_session_id like 'live_%' then 'gpt-live' end),
      voice_flow = coalesce(voice_flow, 'planner')
    where clinic_id = c;
  end loop;
  perform set_config('app.clinic_id', '', true);
end $$;

-- What one call cost us, worked out when it closes from one rates table (packages/core
-- call-costs.ts, its version on the row): the engine's voice minutes, the models' tokens,
-- the texts it sent and the phone line. Estimates for the margin per clinic, never a bill.
-- Numbers only: no words, no phone numbers.
create table if not exists call_costs (
  call_id        uuid primary key references calls(id) on delete cascade,
  clinic_id      text not null references clinics(id) on delete cascade,
  engine         text not null,
  voice_seconds  numeric(10, 2),
  voice_usd      numeric(12, 6) not null default 0,
  -- per model: { "gpt-6-luna": { "input": 1200, "cached": 800, "output": 90 } }
  model_tokens   jsonb not null default '{}'::jsonb,
  model_usd      numeric(12, 6) not null default 0,
  texts          integer not null default 0,
  texts_usd      numeric(12, 6) not null default 0,
  telephony_usd  numeric(12, 6) not null default 0,
  total_usd      numeric(12, 6) not null default 0,
  rates_version  text not null,
  created_at     timestamptz not null default now(),
  constraint call_costs_engine_known check (engine in ('gpt-live', 'gpt-realtime', 'vapi')),
  constraint call_costs_positive check (voice_usd >= 0 and model_usd >= 0 and texts >= 0 and texts_usd >= 0 and telephony_usd >= 0 and total_usd >= 0)
);
grant select, insert, update on call_costs to attendra_app;
alter table call_costs enable row level security;
alter table call_costs force row level security;
create policy call_costs_clinic on call_costs using (clinic_id = current_setting('app.clinic_id', true)) with check (clinic_id = current_setting('app.clinic_id', true));
create index if not exists call_costs_clinic_created on call_costs (clinic_id, created_at);
