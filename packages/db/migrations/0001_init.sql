-- Attendra schema v1.
-- Every table that holds clinic data carries clinic_id and a Row Level Security
-- policy. The application role cannot bypass RLS, so a query that forgets its
-- tenant filter returns nothing instead of another clinic's patients.

create extension if not exists btree_gist;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'attendra_app') then
    create role attendra_app nologin;
  end if;
end $$;

create table organizations (
  id            text primary key,
  name          text not null,
  plan          text not null default 'self_hosted',
  baa_signed_at timestamptz
);

create table clinics (
  id         text primary key,
  org_id     text not null references organizations(id),
  name       text not null,
  timezone   text not null,
  config     jsonb not null,             -- ClinicConfig from @attendra/core, validated on write
  created_at timestamptz not null default now()
);

-- Looked up before the tenant is known (which clinic was dialled?), so no RLS.
-- It holds only the clinic's public numbers.
create table phone_numbers (
  e164       text primary key,
  clinic_id  text not null references clinics(id),
  twilio_sid text,
  status     text not null default 'active'
);

-- Patient identifiers are encrypted in the application (AES-256-GCM). The two
-- hashes are keyed HMACs, so lookups work without storing names or DOBs in clear.
create table patients (
  id             uuid primary key default gen_random_uuid(),
  clinic_id      text not null references clinics(id),
  lookup_hash    text not null,          -- hmac(last name | dob)
  first_name_enc text not null,
  last_name_enc  text not null,
  dob_enc        text not null,
  phone_enc      text,
  phone_hash     text,
  external_ref   text,                   -- the EHR's id, once an adapter is connected
  created_at     timestamptz not null default now()
);
create index patients_lookup on patients (clinic_id, lookup_hash);

create table appointments (
  id                   uuid primary key default gen_random_uuid(),
  clinic_id            text not null references clinics(id),
  patient_id           uuid not null references patients(id),
  provider_id          text not null,
  visit_type_id        text not null,
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  status               text not null default 'booked' check (status in ('booked', 'cancelled')),
  idempotency_key      text not null,
  created_by_call_id   uuid,
  cancel_key           text,
  cancelled_by_call_id uuid,
  created_at           timestamptz not null default now(),
  unique (clinic_id, idempotency_key),
  unique (clinic_id, cancel_key),
  -- The last line of defence against double booking: two booked appointments for
  -- one provider can never overlap, whatever the application does.
  exclude using gist (clinic_id with =, provider_id with =, tstzrange(starts_at, ends_at) with &&) where (status = 'booked')
);

create table calls (
  id                uuid primary key default gen_random_uuid(),
  clinic_id         text not null references clinics(id),
  openai_session_id text not null unique,
  from_hash         text,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  outcome           text,
  emergency_flag    boolean not null default false,
  voice_seconds     numeric(10, 2),
  close_reason      text
);

create table call_segments (
  id        bigserial primary key,
  clinic_id text not null references clinics(id),
  call_id   uuid not null references calls(id) on delete cascade,
  speaker   text not null check (speaker in ('caller', 'agent')),
  text_enc  text not null,
  start_ms  integer not null,
  end_ms    integer not null
);

-- One row per backend tool call. The idempotency key is what makes "check before
-- retry" possible after a reconnect or a duplicated delegation.
create table call_actions (
  id              bigserial primary key,
  clinic_id       text not null references clinics(id),
  call_id         uuid not null references calls(id) on delete cascade,
  tool            text not null,
  args_redacted   jsonb not null,
  result          jsonb not null,
  idempotency_key text,
  task_revision   integer not null,
  created_at      timestamptz not null default now()
);

create table tasks (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       text not null references clinics(id),
  type            text not null check (type in ('callback', 'refill', 'voicemail', 'review')),
  status          text not null default 'open' check (status in ('open', 'done')),
  call_id         uuid references calls(id),
  patient_id      uuid references patients(id),
  details_enc     text not null,
  idempotency_key text not null,
  created_at      timestamptz not null default now(),
  unique (clinic_id, idempotency_key)
);

create table sms_messages (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       text not null references clinics(id),
  template        text not null,
  to_hash         text not null,
  status          text not null default 'queued',
  idempotency_key text not null,
  created_at      timestamptz not null default now(),
  unique (clinic_id, idempotency_key)
);

-- Append-only by permission, not by convention: the app role can insert, never
-- update or delete.
create table audit_logs (
  id        bigserial primary key,
  clinic_id text not null references clinics(id),
  actor     text not null,
  action    text not null,
  entity    text not null,
  entity_id text,
  call_id   uuid,
  at        timestamptz not null default now()
);

-- OpenAI and Twilio retry webhooks; a delivery id seen once is never handled twice.
create table webhook_deliveries (
  id          text primary key,
  source      text not null,
  received_at timestamptz not null default now()
);

grant usage on schema public to attendra_app;
grant select on organizations, clinics, phone_numbers to attendra_app;
grant select, insert, update on patients, appointments, calls, call_segments, call_actions, tasks, sms_messages to attendra_app;
grant insert, select on audit_logs to attendra_app;
grant insert, select on webhook_deliveries to attendra_app;
grant usage, select on all sequences in schema public to attendra_app;

alter table clinics enable row level security;
create policy clinics_self on clinics for select using (id = current_setting('app.clinic_id', true));

do $$ declare t text; begin
  foreach t in array array['patients', 'appointments', 'calls', 'call_segments', 'call_actions', 'tasks', 'sms_messages', 'audit_logs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I_clinic on %I using (clinic_id = current_setting(''app.clinic_id'', true)) with check (clinic_id = current_setting(''app.clinic_id'', true))',
      t, t);
  end loop;
end $$;
