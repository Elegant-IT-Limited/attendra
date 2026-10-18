-- Attendra schema v31: which members may approve or decline a refill.
-- Nobody, until an owner or a manager says so on the Team page.
alter table memberships add column if not exists approves_refills boolean not null default false;
