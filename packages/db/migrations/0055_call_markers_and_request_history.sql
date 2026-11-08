-- Attendra schema v55: how a call went for the caller, the call list's filters, and a request's history (batch 4b).
--
-- calls.max_gap_ms          the longest the caller waited in silence after they finished speaking, from the end of their
--                           words to the start of the assistant's reply (the call's own timeline); null when the call had
--                           no such turn, or closed before v55
-- calls.repeated_questions  how many times the assistant asked a question it had already asked, with the caller's
--                           answer in between and no "say that again" from them (core repeatedQuestions); null before v55
--
-- The Calls list filters by outcome, by how an emergency ended and by channel, newest first, a page at a time: an index
-- for each, so a filter that matches a few calls in many does not read them all. A browser test call is the rare channel
-- (the phone is most calls, which the list's own index already covers).
--
-- A request's history is the audit log's rows about it (created, claimed, handed over, closed, reopened, notes): read
-- one request at a time, by its id, through a partial index on the request rows only.
--
-- Additive: older code ignores both columns. Nothing on file is filled in.
alter table calls add column if not exists max_gap_ms integer;
alter table calls add column if not exists repeated_questions integer;
alter table calls add constraint calls_max_gap_ms_known check (max_gap_ms is null or max_gap_ms >= 0);
alter table calls add constraint calls_repeated_questions_known check (repeated_questions is null or repeated_questions >= 0);

create index if not exists calls_by_outcome on calls (clinic_id, outcome, started_at desc, id desc);
create index if not exists calls_by_emergency_result on calls (clinic_id, emergency_result, started_at desc, id desc) where emergency_result is not null;
create index if not exists calls_browser_tests on calls (clinic_id, started_at desc, id desc) where channel = 'web';

create index if not exists audit_logs_task_history on audit_logs (clinic_id, entity_id, at) where entity = 'task';

-- Rollback:
--   drop index if exists audit_logs_task_history, calls_browser_tests, calls_by_emergency_result, calls_by_outcome;
--   alter table calls drop constraint if exists calls_repeated_questions_known, drop constraint if exists calls_max_gap_ms_known;
--   alter table calls drop column if exists repeated_questions, drop column if exists max_gap_ms;
