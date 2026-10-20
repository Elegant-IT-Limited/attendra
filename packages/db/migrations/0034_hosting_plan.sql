-- Attendra schema v34: the hosting layer's plan for a clinic, so every member sees the
-- month's call minutes and the trial's days in the dashboard.
--
-- Empty, as on a self-hosted install, shows nothing. The hosting layer sets it on every change
-- (status, period, trial end); it lives outside the clinic's settings, which staff edit.
alter table clinics add column if not exists hosting_plan jsonb;
