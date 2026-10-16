-- Attendra schema v27: the clinic's own details on each patient or pet.
--
-- The fields themselves (a label and a kind) are in the clinic's settings; the values
-- staff fill in on a record are one JSON object keyed by field id, encrypted like the
-- other details. Empty until someone fills one in.
alter table patients add column if not exists custom_enc text;
