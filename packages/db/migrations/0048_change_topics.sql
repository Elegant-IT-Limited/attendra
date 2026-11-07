-- Attendra schema v48: more of the dashboard hears about changes as they happen.
--
-- 1. A person's own notices (topic 'me'): an invitation to their address, a role given,
--    changed or taken away at any location. The notice names the person, never the
--    clinic or the row, so a tab outside any clinic (the start page, the profile) can
--    ask who it is and which invitations wait, and the banner and the clinic switcher
--    follow at once. Per-location 'team' notices (0046) stay for the Team page.
-- 2. 'knowledge' (a document queued, indexed or failed) and 'texts' (a text sent,
--    delivered or failed): the Knowledge page and a call's texts stop polling.
--
-- As in 0021, a notice carries words only; the browser reads again through the usual,
-- permission-checked and audited routes.

-- The clinic of the row, read straight from the column: unlike attendra_notify_change
-- (0021) it does not turn the whole row into JSON, which for a knowledge document means
-- its file.
create function attendra_notify_clinic_change() returns trigger language plpgsql as $$
begin
  perform pg_notify('attendra_changes', json_build_object('clinic', case when tg_op = 'DELETE' then old.clinic_id else new.clinic_id end, 'topic', tg_argv[0])::text);
  return null;
end $$;

create trigger knowledge_documents_changed after insert or update or delete on knowledge_documents for each row execute function attendra_notify_clinic_change('knowledge');
create trigger sms_messages_changed after insert or update on sms_messages for each row execute function attendra_notify_clinic_change('texts');

-- A person's own access: their row at a location, or their owner row.
create function attendra_notify_user_change() returns trigger language plpgsql as $$
declare
  who text := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
begin
  perform pg_notify('attendra_changes', json_build_object('user', who, 'topic', 'me')::text);
  -- a row that moved to another person (never done by the code, but cheap to cover)
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    perform pg_notify('attendra_changes', json_build_object('user', old.user_id, 'topic', 'me')::text);
  end if;
  return null;
end $$;

create trigger clinic_memberships_user_changed after insert or update or delete on clinic_memberships for each row execute function attendra_notify_user_change();
create trigger memberships_user_changed after insert or update or delete on memberships for each row execute function attendra_notify_user_change();

-- An invitation belongs to an address: the login with that address, when there is one,
-- hears about it. An address with no login yet has nobody to tell; its email does that.
create function attendra_notify_invitee() returns trigger language plpgsql as $$
declare
  addr text := lower(case when tg_op = 'DELETE' then old.email else new.email end);
  u record;
begin
  for u in select id from auth_users where lower(email) = addr loop
    perform pg_notify('attendra_changes', json_build_object('user', u.id, 'topic', 'me')::text);
  end loop;
  return null;
end $$;

create trigger invitations_invitee_changed after insert or update or delete on invitations for each row execute function attendra_notify_invitee();

-- Rollback (by hand): drop the five triggers and the three functions above.
--   drop trigger knowledge_documents_changed on knowledge_documents; drop trigger sms_messages_changed on sms_messages;
--   drop trigger clinic_memberships_user_changed on clinic_memberships; drop trigger memberships_user_changed on memberships;
--   drop trigger invitations_invitee_changed on invitations;
--   drop function attendra_notify_clinic_change(); drop function attendra_notify_user_change(); drop function attendra_notify_invitee();
