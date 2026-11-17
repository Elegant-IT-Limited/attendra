-- Attendra schema v63: a text that was not sent, marked handled by a person (2026-11-17, texts polish TX2).
--
-- sms_messages.handled_at  when someone marked a text that was not sent as handled (they called the owner instead,
--                          or it needs nothing): it leaves Today and the dashboard's notice. Audited as sms.handled.
-- sms_messages.handled_by  who did: the staff member's id.
--
-- sms_messages_search      the clinic's texts by kind, newest first, for the Texts page's filters and paging.
--
-- Additive: older code reads none of it.
alter table sms_messages
  add column if not exists handled_at timestamptz,
  add column if not exists handled_by text;
create index if not exists sms_messages_search on sms_messages (clinic_id, template, created_at desc);
