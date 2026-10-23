-- Attendra schema v36: the number a call came from, readable by staff.
--
-- Until now a call kept only a one-way hash of the caller's number (for limits), so a
-- caller who asked to be called back could not be called back from the call or its
-- request. The number is now kept encrypted like every other caller detail, shown to the
-- roles that may read calls, and cleared with the transcript when the clinic's retention
-- period ends.
alter table calls add column if not exists from_enc text;
