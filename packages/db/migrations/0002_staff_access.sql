-- Attendra schema v2: staff accounts, organization membership, and the task workflow.
--
-- The auth_* tables belong to Better Auth and are read and written only by the
-- API's owner connection. attendra_app gets no grant on them, so a bug in a
-- clinic-scoped query can never reach a password hash or a session token.

create table auth_users (
  id                 text primary key,
  name               text not null,
  email              text not null unique,
  email_verified     boolean not null default false,
  image              text,
  two_factor_enabled boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table auth_sessions (
  id                     text primary key,
  user_id                text not null references auth_users(id) on delete cascade,
  token                  text not null unique,
  expires_at             timestamptz not null,
  ip_address             text,
  user_agent             text,
  active_organization_id text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index auth_sessions_user on auth_sessions (user_id);

create table auth_accounts (
  id                       text primary key,
  user_id                  text not null references auth_users(id) on delete cascade,
  account_id               text not null,
  provider_id              text not null,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index auth_accounts_user on auth_accounts (user_id);

create table auth_verifications (
  id         text primary key,
  identifier text not null,
  value      text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index auth_verifications_identifier on auth_verifications (identifier);

-- TOTP secrets and backup codes, encrypted by Better Auth with BETTER_AUTH_SECRET.
create table auth_two_factors (
  id                        text primary key,
  user_id                   text not null references auth_users(id) on delete cascade,
  secret                    text not null,
  backup_codes              text not null,
  verified                  boolean not null default true,
  failed_verification_count integer not null default 0,
  locked_until              timestamptz
);
create index auth_two_factors_user on auth_two_factors (user_id);

-- Organizations are shared with Better Auth's organization plugin, which needs a
-- slug and a creation time.
alter table organizations
  add column slug       text,
  add column logo       text,
  add column metadata   text,
  add column created_at timestamptz not null default now();
update organizations set slug = id where slug is null;
alter table organizations alter column slug set not null;
alter table organizations add constraint organizations_slug_key unique (slug);

-- One role per person per organization. The roles and what each may do live in
-- apps/api/src/access.ts; the check here stops a typo from becoming a silent role.
create table memberships (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  user_id         text not null references auth_users(id) on delete cascade,
  role            text not null default 'viewer' check (role in ('owner', 'admin', 'staff', 'viewer')),
  created_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index memberships_user on memberships (user_id);

create table invitations (
  id              text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  email           text not null,
  role            text,
  status          text not null default 'pending',
  inviter_id      text not null references auth_users(id) on delete cascade,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);
create index invitations_org on invitations (organization_id);
create index invitations_email on invitations (email);

-- The front-desk queue: who picked a task up, and who closed it.
alter table tasks
  add column assignee_user_id text,
  add column claimed_at       timestamptz,
  add column done_at          timestamptz,
  add column done_by_user_id  text;
create index tasks_queue on tasks (clinic_id, status, created_at);

create index calls_recent on calls (clinic_id, started_at desc);
create index audit_logs_recent on audit_logs (clinic_id, at desc);

-- Managers edit clinic settings through the API, as the application role and
-- inside the clinic's own scope.
grant update (name, timezone, config) on clinics to attendra_app;
create policy clinics_self_update on clinics for update
  using (id = current_setting('app.clinic_id', true))
  with check (id = current_setting('app.clinic_id', true));
