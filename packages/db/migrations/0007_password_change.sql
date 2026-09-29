-- Attendra schema v7: a temporary password is for one sign-in.
--
-- The password a manager reads off the screen when they add someone must not stay
-- that person's password: the manager knows it. While must_change_password is set,
-- the API serves nothing but "who am I" until the person picks their own, and a
-- temporary password stops working 72 hours after it was issued.
alter table auth_users
  add column must_change_password          boolean not null default false,
  add column temporary_password_expires_at timestamptz;
