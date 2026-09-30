-- Attendra schema v13: API keys, for other AI agents working with the front desk over MCP.
--
-- A key is shown once, when it is made; only its SHA-256 is kept, so a database dump
-- holds nothing that works. Each key belongs to one clinic, has scopes and an expiry,
-- and every use is audited with its id. A key is found by its hash before the clinic
-- is known, by the owner connection, like a dialled number.

create table api_keys (
  id                 uuid primary key default gen_random_uuid(),
  clinic_id          text not null references clinics(id),
  name               text not null check (length(name) between 1 and 100),
  prefix             text not null, -- the first characters, so a person can tell keys apart
  key_hash           text not null unique,
  scopes             text[] not null,
  expires_at         timestamptz not null,
  created_by_user_id text not null,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz
);
create index api_keys_clinic on api_keys (clinic_id, created_at desc);

alter table api_keys enable row level security;
alter table api_keys force row level security;
create policy api_keys_clinic on api_keys
  using (clinic_id = current_setting('app.clinic_id', true))
  with check (clinic_id = current_setting('app.clinic_id', true));
grant select, insert, update on api_keys to attendra_app;
