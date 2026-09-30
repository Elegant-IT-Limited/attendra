-- Attendra schema v10: a staff member's own number, for taking over a live call.
--
-- Optional, and per organization: someone who works at two practices can take calls
-- on a different phone at each. It is a staff member's work number, not patient data.

alter table memberships
  add column transfer_number text check (transfer_number ~ '^\+[1-9][0-9]{7,14}$');
