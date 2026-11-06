-- Attendra schema v46: access per location, not per business.
--
-- Until now a person's role lived on the organization (memberships), so an invitation
-- "to Maple Street" opened every location of the business with the same role, and one
-- person could not be a manager at one location and front desk at another. From here:
--
--   * an owner stays account-wide: a memberships row with role 'owner' opens every
--     location of the business, today's and later ones (billing, locations, setup);
--   * every other role is per location: one clinic_memberships row per location the
--     person was invited to, with that location's role, refill approval and take-over number.
--
-- clinic_access is the one place the two meet: one row per (location, person) with the
-- role there. Every reader (the guard, /me, the Team page, "Assign to", names in the
-- audit log, API key holders) reads the view, so the rule lives here once.
--
-- Nobody loses access: every non-owner membership becomes one row per location of its
-- business, closed ones included (a location that reopens keeps its team). The old
-- non-owner rows are kept in memberships_before_0046 for one release, so the change can
-- be undone (see the rollback at the end), and then removed from memberships.
--
-- Auth tables: read and written by the API's owner connection only, no grant to attendra_app.

create table clinic_memberships (
  id               text primary key,
  clinic_id        text not null references clinics(id) on delete cascade,
  user_id          text not null references auth_users(id) on delete cascade,
  -- an owner is account-wide (memberships), never a per-location row
  role             text not null check (role in ('admin', 'staff', 'viewer')),
  approves_refills boolean not null default false,
  transfer_number  text check (transfer_number ~ '^\+[1-9][0-9]{7,14}$'),
  created_at       timestamptz not null default now(),
  unique (clinic_id, user_id)
);
create index clinic_memberships_user on clinic_memberships (user_id);

create table memberships_before_0046 as select * from memberships where role <> 'owner';

insert into clinic_memberships (id, clinic_id, user_id, role, approves_refills, transfer_number, created_at)
select m.id || ':' || c.id, c.id, m.user_id, m.role, m.approves_refills, m.transfer_number, m.created_at
  from memberships m join clinics c on c.org_id = m.organization_id
 where m.role <> 'owner'
on conflict (clinic_id, user_id) do nothing;

delete from memberships where role <> 'owner';
-- from here memberships holds owners only: the account-wide link
alter table memberships add constraint memberships_owner_only check (role = 'owner');

-- Who may open which location, with which role. An owner's row wins over a stray
-- per-location row of the same person (the code never writes both).
create view clinic_access as
  select c.id as clinic_id, m.user_id, 'owner'::text as role, m.approves_refills, m.transfer_number, m.created_at, true as account_wide
    from memberships m join clinics c on c.org_id = m.organization_id
  union all
  select cm.clinic_id, cm.user_id, cm.role, cm.approves_refills, cm.transfer_number, cm.created_at, false as account_wide
    from clinic_memberships cm join clinics c on c.id = cm.clinic_id
   where not exists (select 1 from memberships o where o.organization_id = c.org_id and o.user_id = cm.user_id);

-- Invitations are per location now: one open invitation per address per location, and
-- "every location" sends one per location, tied together so one Accept answers them all.
drop index if exists invitations_one_pending;
alter table invitations add column if not exists group_id text;
create unique index invitations_one_pending on invitations (clinic_id, email) where status = 'pending';
create index invitations_group on invitations (group_id) where group_id is not null;

-- A role change, a removal or an invitation reaches the dashboard at once: the 'team' topic
-- tells the location's open tabs to ask who they are again (/me), so the menu and every
-- button follow the new role on the next click instead of a minute later.
create trigger clinic_memberships_changed after insert or update or delete on clinic_memberships for each row execute function attendra_notify_change('team');
create trigger invitations_changed after insert or update or delete on invitations for each row execute function attendra_notify_change('team');
-- an owner's row is about every location of the business
create function attendra_notify_owner_change() returns trigger language plpgsql as $$
declare
  org text := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
  c record;
begin
  for c in select id from clinics where org_id = org loop
    perform pg_notify('attendra_changes', json_build_object('clinic', c.id, 'topic', 'team')::text);
  end loop;
  return null;
end $$;
create trigger memberships_changed after insert or update or delete on memberships for each row execute function attendra_notify_owner_change();

-- Rollback (by hand, one transaction, before memberships_before_0046 is dropped):
--   alter table memberships drop constraint memberships_owner_only;
--   insert into memberships select * from memberships_before_0046 on conflict do nothing;
--   drop trigger memberships_changed on memberships; drop function attendra_notify_owner_change(); drop trigger invitations_changed on invitations;
--   drop view clinic_access; drop table clinic_memberships;
--   drop index invitations_one_pending; drop index invitations_group; alter table invitations drop column group_id;
--   create unique index invitations_one_pending on invitations (organization_id, email) where status = 'pending';
--   delete from schema_migrations where id = '0046_clinic_memberships.sql';
-- People invited after the deploy are then added back as organization members by hand.
