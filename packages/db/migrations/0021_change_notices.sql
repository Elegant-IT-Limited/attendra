-- Attendra schema v21: the dashboard hears about changes as they happen.
--
-- Every write to the tables the dashboard shows sends a notice on the channel
-- attendra_changes: the clinic and what kind of thing changed, never the row. The API
-- listens and tells the browsers signed in to that clinic, which then ask for the
-- page again through the usual, audited routes. Postgres sends a notice when the
-- transaction commits, and folds identical notices in one transaction into one, so a
-- bulk import of thousands of patients is one notice.
create or replace function attendra_notify_change() returns trigger language plpgsql as $$
declare
  r jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  perform pg_notify('attendra_changes', json_build_object('clinic', coalesce(r->>'clinic_id', r->>'id'), 'topic', tg_argv[0])::text);
  return null;
end $$;

create trigger tasks_changed after insert or update or delete on tasks for each row execute function attendra_notify_change('requests');
create trigger task_notes_changed after insert on task_notes for each row execute function attendra_notify_change('requests');
create trigger appointments_changed after insert or update or delete on appointments for each row execute function attendra_notify_change('schedule');
create trigger patients_changed after insert or update or delete on patients for each row execute function attendra_notify_change('patients');
create trigger calls_changed after insert or update on calls for each row execute function attendra_notify_change('calls');
create trigger call_summaries_changed after insert or update on call_summaries for each row execute function attendra_notify_change('calls');
-- doctors, their hours and days off live in the clinic's settings
create trigger clinics_changed after update on clinics for each row execute function attendra_notify_change('settings');
