-- Attendra schema v63: a text that was not sent, marked handled by a person (2026-11-17, texts polish TX2).
--
-- sms_messages.handled_at  when someone marked a text that was not sent as handled (they called the owner instead,
--                          or it needs nothing): it leaves Today and the dashboard's notice. Audited as sms.handled.
-- sms_messages.handled_by  who did: the staff member's id.
--
-- sms_messages_search      the clinic's texts by kind, newest first, for the Texts page's filters and paging.
--
-- text_words_kept_since()  when this database started keeping the words of each text: when 0059 (text bodies) was
--                          applied. A sent text from before then says "Words not kept (sent before 16 Nov)" (TX5).
--                          The services' role may not read schema_migrations (0051), so it gets this one date only.
--
-- Additive: older code reads none of it.
alter table sms_messages
  add column if not exists handled_at timestamptz,
  add column if not exists handled_by text;
create index if not exists sms_messages_search on sms_messages (clinic_id, template, created_at desc);
create or replace function text_words_kept_since()
  returns timestamptz
  language sql stable security definer set search_path = pg_catalog, public as $$
  select applied_at from public.schema_migrations where id = '0059_text_bodies.sql'
$$;
revoke all on function text_words_kept_since() from public;
grant execute on function text_words_kept_since() to attendra_service;
