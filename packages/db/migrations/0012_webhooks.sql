-- Attendra schema v12: webhooks, so a clinic can connect n8n, Zapier, Make or its own systems.
--
-- An endpoint's secret signs every delivery; it is encrypted like the PHI columns,
-- because anyone holding it can forge deliveries. During a rotation the previous
-- secret keeps working until it expires. Events and payloads hold ids, times, codes
-- and counts only, never patient details. Every attempt is logged with its status
-- code and timing, and an endpoint that keeps failing is turned off.

create table webhook_endpoints (
  id                   uuid primary key default gen_random_uuid(),
  clinic_id            text not null references clinics(id),
  url                  text not null check (length(url) <= 2000),
  description          text not null default '' check (length(description) <= 200),
  events               text[] not null,
  secret_enc           text not null,
  previous_secret_enc  text,
  previous_expires_at  timestamptz,
  enabled              boolean not null default true,
  disabled_reason      text, -- a code: repeated_failures
  disabled_at          timestamptz,
  consecutive_failures integer not null default 0,
  created_by_user_id   text not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (clinic_id, id)
);

create table webhook_events (
  id          text primary key,
  clinic_id   text not null references clinics(id),
  type        text not null,
  data        jsonb not null,
  occurred_at timestamptz not null,
  created_at  timestamptz not null default now()
);
create index webhook_events_clinic on webhook_events (clinic_id, created_at desc);

create table webhook_attempts (
  id          bigserial primary key,
  clinic_id   text not null,
  endpoint_id uuid not null,
  event_id    text not null references webhook_events(id),
  kind        text not null check (kind in ('automatic', 'test', 'redelivery')),
  attempt     integer not null,
  status_code integer,
  duration_ms integer not null,
  error       text, -- a code: http_500, timeout, private_address
  at          timestamptz not null default now(),
  foreign key (clinic_id, endpoint_id) references webhook_endpoints (clinic_id, id) on delete cascade
);
create index webhook_attempts_endpoint on webhook_attempts (clinic_id, endpoint_id, at desc);

do $$ declare t text; begin
  foreach t in array array['webhook_endpoints', 'webhook_events', 'webhook_attempts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I_clinic on %I using (clinic_id = current_setting(''app.clinic_id'', true)) with check (clinic_id = current_setting(''app.clinic_id'', true))',
      t, t);
  end loop;
end $$;
grant select, insert, update, delete on webhook_endpoints to attendra_app;
grant select, insert on webhook_events, webhook_attempts to attendra_app;
grant usage, select on sequence webhook_attempts_id_seq to attendra_app;
