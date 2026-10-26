-- Attendra schema v38: invitations to join a team.
--
-- The table came with Better Auth's organization plugin (0002) and was never used: those
-- routes stay closed. An owner or a manager invites an email; the person accepts or
-- declines from their own dashboard, and an invitation not answered in 7 days lapses.
-- The email is kept normalised (trimmed, lower case), as auth_users keeps it: this is an
-- auth table, read by the API's owner connection only, with no grant to attendra_app.
alter table invitations
  -- the location it was sent from, for "Maple Street invited you"
  add column if not exists clinic_id        text references clinics(id) on delete cascade,
  add column if not exists approves_refills boolean not null default false,
  -- when it was accepted, declined, cancelled or lapsed
  add column if not exists decided_at       timestamptz;

alter table invitations add constraint invitations_role_check check (role in ('owner', 'admin', 'staff', 'viewer'));
alter table invitations add constraint invitations_status_check check (status in ('pending', 'accepted', 'declined', 'canceled', 'expired'));
-- one open invitation per address per team: sending it again renews that one
create unique index if not exists invitations_one_pending on invitations (organization_id, email) where status = 'pending';
create index if not exists invitations_pending_expiry on invitations (expires_at) where status = 'pending';
