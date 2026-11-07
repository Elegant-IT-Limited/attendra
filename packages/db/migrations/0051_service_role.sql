-- The services' own role: they connect as attendra_service instead of the database's owner.
-- It is no superuser, has no BYPASSRLS, owns no table and cannot create one, so row-level
-- security holds for every query it makes, inside withClinic and out: a query that forgets
-- the clinic sees no clinic's rows. Migrations keep running as the owner.
--
-- Made without a login here: the deploy gives it one (`alter role attendra_service login
-- password ...`, docs/self-hosting.md, "The services' own role"), so no password is ever in a migration. It is a member
-- of attendra_app, so `set local role attendra_app` in withClinic still works, and gets
-- the same rights on the tables a later migration adds (default privileges below).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'attendra_service') then
    create role attendra_service nologin nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
  end if;
end $$;
alter role attendra_service nosuperuser nobypassrls nocreatedb nocreaterole;
grant attendra_app to attendra_service;

grant usage on schema public to attendra_service;
grant select, insert, update, delete on all tables in schema public to attendra_service;
grant usage, select, update on all sequences in schema public to attendra_service;
alter default privileges in schema public grant select, insert, update, delete on tables to attendra_service;
alter default privileges in schema public grant usage, select, update on sequences to attendra_service;
-- which migrations ran is the migrator's business
revoke all on schema_migrations from attendra_service;

-- The tenant registry: organizations, clinics and phone numbers. Not patient data: names,
-- settings and the numbers calls come in on. The services read and write it before a clinic
-- is known (which clinic owns the number dialled, opening an account, the worker's list of
-- clinics), so the services' role sees every clinic here. organizations and phone_numbers have
-- no row-level security, so the grants above are enough; clinics has it, so it gets a policy for
-- this role only. Inside withClinic the role is attendra_app, which still sees its own clinic only.
create policy clinics_service on clinics for all to attendra_service using (true) with check (true);

-- Everything else with a clinic_id keeps its policy: no clinic set, no row. The few reads that
-- must happen before the clinic is known are functions that run as the owner and return only what
-- they are for. Each sets its own search_path, and only the services' role may call it.

-- An API key, by the hash of the key a request carries: which clinic it is for, and what it may do.
-- Nothing else about the clinic or its keys. Whether its maker may still hold one is checked after,
-- in that clinic (apiKeyIsLive), so the rule is written once.
create or replace function api_key_by_hash(p_key_hash text)
  returns table (id uuid, clinic_id text, scopes text[], created_by_user_id text, expires_at timestamptz, revoked_at timestamptz)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select k.id, k.clinic_id, k.scopes, k.created_by_user_id, k.expires_at, k.revoked_at from public.api_keys k
  where k.key_hash = p_key_hash
$$;
revoke all on function api_key_by_hash(text) from public;
grant execute on function api_key_by_hash(text) to attendra_service;

-- The worker's job queue (pg-boss) runs on the owner's connection: it creates and upgrades its
-- own schema. The services' role only deletes a purged clinic's jobs (purgeClosedClinic). The
-- worker grants the same when it makes the schema on a database this ran on before it.
do $$ begin
  if to_regclass('pgboss.job') is not null then
    execute 'grant usage on schema pgboss to attendra_service';
    execute 'grant select, delete on pgboss.job to attendra_service';
  end if;
end $$;

-- Rollback (the services go back to the owner's URL first):
--   drop function api_key_by_hash(text);
--   drop policy clinics_service on clinics;
--   revoke all on all tables in schema public from attendra_service;
--   revoke all on all sequences in schema public from attendra_service;
--   alter default privileges in schema public revoke all on tables from attendra_service;
--   alter default privileges in schema public revoke all on sequences from attendra_service;
--   revoke all on schema public from attendra_service;
--   (and if pgboss exists) revoke all on pgboss.job from attendra_service; revoke all on schema pgboss from attendra_service;
--   revoke attendra_app from attendra_service;
--   drop role attendra_service;
