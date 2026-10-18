-- Attendra schema v32: the clinic's own details on a request (Settings, Fields and lists),
-- encrypted like a patient's, since staff may write anything there.
alter table tasks add column if not exists custom_enc text;
