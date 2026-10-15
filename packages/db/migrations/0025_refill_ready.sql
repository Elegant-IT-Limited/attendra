-- Attendra schema v25: a refill the team approved, and one it declined.
--
-- "Ready to pick up" tells the caller by text, from a fixed template that says what
-- and where, never which medication. "Declined" is closed with a call back. The
-- outcomes so far stay as they were.
alter table tasks drop constraint if exists tasks_outcome_check;
alter table tasks add constraint tasks_outcome_check check (outcome in ('called_back', 'left_message', 'refill_sent', 'refill_ready', 'refill_declined', 'not_needed', 'details_confirmed'));
