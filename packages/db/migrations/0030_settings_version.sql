-- Attendra schema v30: a version on the clinic's settings, so two people saving
-- Settings at once cannot silently undo each other. Every save adds one.
alter table clinics
  add column if not exists config_version integer not null default 1,
  add column if not exists config_updated_at timestamptz,
  add column if not exists config_updated_by text;
grant update (config_version, config_updated_at, config_updated_by) on clinics to attendra_app;
