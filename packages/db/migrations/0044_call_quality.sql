-- Attendra schema v44: how each call sounded to the caller, as numbers (batch 0, the safety net).
--
-- Kept on the call row so the daily digest, the Calls list and later the call statistics
-- read them from the database instead of from logs that rotate:
--   first_audio_ms   how long after the call was answered the caller first heard the
--                    assistant; null when they never did (outcome no_audio)
--   stalls           caller turns that met 5 s of silence with nothing coming back
--   answer_timeouts  answers that took longer than the 60 s limit and were apologised for
-- Counts only: no words, no numbers. Null on calls closed before this migration.
alter table calls add column if not exists first_audio_ms integer;
alter table calls add column if not exists stalls integer;
alter table calls add column if not exists answer_timeouts integer;
alter table calls add constraint calls_first_audio_ms_positive check (first_audio_ms is null or first_audio_ms >= 0);
alter table calls add constraint calls_stalls_positive check (stalls is null or stalls >= 0);
alter table calls add constraint calls_answer_timeouts_positive check (answer_timeouts is null or answer_timeouts >= 0);
-- the digest reads the last day of calls across clinics
create index if not exists calls_started_at_idx on calls (started_at);
