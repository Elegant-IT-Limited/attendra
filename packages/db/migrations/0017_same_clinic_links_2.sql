-- Attendra schema v17: the rest of the links between clinic rows stay inside one clinic.
--
-- 0008 and 0016 made a call's patient and a summary's call composite keys. These
-- links were still single-column, so Row Level Security (which foreign key checks
-- ignore) was the only thing stopping, say, a request that names another clinic's
-- call; and an appointment's booking and cancelling calls had no key at all.
--
-- First, count what would break each new key. A database that holds such a row
-- stops here with a message naming it: this migration never changes data.
do $$
declare
  problems text := '';
  n bigint;
begin
  select count(*) into n from appointments a where not exists (select 1 from patients p where p.id = a.patient_id and p.clinic_id = a.clinic_id);
  if n > 0 then problems := problems || format(E'\n  %s appointments whose patient is in another clinic', n); end if;
  select count(*) into n from appointments a where a.created_by_call_id is not null and not exists (select 1 from calls c where c.id = a.created_by_call_id and c.clinic_id = a.clinic_id);
  if n > 0 then problems := problems || format(E'\n  %s appointments booked by a call that is missing or in another clinic', n); end if;
  select count(*) into n from appointments a where a.cancelled_by_call_id is not null and not exists (select 1 from calls c where c.id = a.cancelled_by_call_id and c.clinic_id = a.clinic_id);
  if n > 0 then problems := problems || format(E'\n  %s appointments cancelled by a call that is missing or in another clinic', n); end if;
  select count(*) into n from tasks t where t.patient_id is not null and not exists (select 1 from patients p where p.id = t.patient_id and p.clinic_id = t.clinic_id);
  if n > 0 then problems := problems || format(E'\n  %s requests whose patient is in another clinic', n); end if;
  select count(*) into n from tasks t where t.call_id is not null and not exists (select 1 from calls c where c.id = t.call_id and c.clinic_id = t.clinic_id);
  if n > 0 then problems := problems || format(E'\n  %s requests whose call is in another clinic', n); end if;
  select count(*) into n from call_segments s where not exists (select 1 from calls c where c.id = s.call_id and c.clinic_id = s.clinic_id);
  if n > 0 then problems := problems || format(E'\n  %s transcript lines whose call is in another clinic', n); end if;
  select count(*) into n from call_actions x where not exists (select 1 from calls c where c.id = x.call_id and c.clinic_id = x.clinic_id);
  if n > 0 then problems := problems || format(E'\n  %s call actions whose call is in another clinic', n); end if;
  select count(*) into n from webhook_attempts w where not exists (select 1 from webhook_events e where e.id = w.event_id and e.clinic_id = w.clinic_id);
  if n > 0 then problems := problems || format(E'\n  %s webhook attempts whose event is in another clinic', n); end if;
  if problems <> '' then
    raise exception 'migration 0017 found rows that link across clinics, and changed nothing:%', problems
      using hint = 'Fix or remove those rows (each count names the table), then run the migration again.';
  end if;
end $$;

alter table webhook_events add constraint webhook_events_clinic_id_id_key unique (clinic_id, id);

alter table appointments drop constraint if exists appointments_patient_id_fkey,
  add constraint appointments_patient_same_clinic foreign key (clinic_id, patient_id) references patients (clinic_id, id),
  add constraint appointments_booked_by_call_same_clinic foreign key (clinic_id, created_by_call_id) references calls (clinic_id, id),
  add constraint appointments_cancelled_by_call_same_clinic foreign key (clinic_id, cancelled_by_call_id) references calls (clinic_id, id);
alter table tasks drop constraint if exists tasks_patient_id_fkey, drop constraint if exists tasks_call_id_fkey,
  add constraint tasks_patient_same_clinic foreign key (clinic_id, patient_id) references patients (clinic_id, id),
  add constraint tasks_call_same_clinic foreign key (clinic_id, call_id) references calls (clinic_id, id);
alter table call_segments drop constraint if exists call_segments_call_id_fkey,
  add constraint call_segments_call_same_clinic foreign key (clinic_id, call_id) references calls (clinic_id, id) on delete cascade;
alter table call_actions drop constraint if exists call_actions_call_id_fkey,
  add constraint call_actions_call_same_clinic foreign key (clinic_id, call_id) references calls (clinic_id, id) on delete cascade;
alter table webhook_attempts drop constraint if exists webhook_attempts_event_id_fkey,
  add constraint webhook_attempts_event_same_clinic foreign key (clinic_id, event_id) references webhook_events (clinic_id, id);
