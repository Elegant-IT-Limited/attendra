-- Attendra schema v59: the words of each text the clinic sent (2026-11-16, text history for the clinic).
--
-- sms_messages.body_enc  the text exactly as it went out (rendered from its template, the clinic's own words included),
--                        encrypted with the data key and bound to the clinic and this column, like other caller data.
--                        Written when the carrier takes it; null for a text refused before the carrier, and for every
--                        text from before this change. Kept for the clinic's call-records retention (retentionDays):
--                        after that the nightly purge sets it to null; the row's kind, status and times stay.
--
-- sms_messages_recent    the clinic's newest texts first, for Settings > Texting's "Recent texts".
--
-- Additive: older code reads none of it.
alter table sms_messages add column if not exists body_enc text;
create index if not exists sms_messages_recent on sms_messages (clinic_id, created_at desc);
