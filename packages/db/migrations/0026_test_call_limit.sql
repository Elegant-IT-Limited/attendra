-- Attendra schema v26: a limit on the time a clinic may spend in browser test calls.
--
-- Empty, as every clinic has it, means no limit. A hosted trial sets it (10 minutes);
-- it lives outside the clinic's settings so the people who edit those cannot raise it.
alter table clinics add column if not exists test_seconds_limit integer check (test_seconds_limit is null or test_seconds_limit >= 0);
