-- Attendra schema v54: what happened to a visit (the desk marks it), and removing a patient record.
--
-- appointments.status            booked | arrived | completed | no_show | cancelled (was booked | cancelled).
--                                The desk moves a visit between the first four and back (core visit-status.ts);
--                                only a booked visit is upcoming for the assistant and can be moved or cancelled.
-- appointments.status_changed_at when the desk last set arrived, completed, no-show or back to booked
-- appointments.status_changed_by the staff member's id who did; both null until the desk marks the visit
--
-- The double-booking guard (the exclusion constraint) now holds for every state that keeps the vet's time:
-- booked, arrived and completed (core HOLDS_TIME). A no-show frees its time for a walk-in, as a cancel does.
-- The constraint's own range is kept as it is: only its WHERE changes, so whatever range an earlier
-- migration gave it (the visit, or the visit and its break) stays.
--
-- patients.deleted_at / deleted_by  a record staff deleted (Patients, "Delete"): every encrypted column is
--                                replaced by a fixed placeholder or emptied, every keyed hash and search key is
--                                removed, and the row itself stays, with no name, number, date of birth or
--                                details, so the visits it had still count in Quality (docs/hipaa.md, "Deleting
--                                and merging patient records"). A merged record is deleted outright, after
--                                everything that pointed at it moved to the record kept.
--
-- Existing rows: every visit keeps its state (booked or cancelled); nothing is marked. No patient is deleted.
alter table appointments drop constraint if exists appointments_status_check;
alter table appointments add constraint appointments_status_check
  check (status in ('booked', 'arrived', 'completed', 'no_show', 'cancelled'));
alter table appointments add column if not exists status_changed_at timestamptz;
alter table appointments add column if not exists status_changed_by text;

do $$
declare
  c record;
  def text;
  fixed text;
begin
  for c in select conname, pg_get_constraintdef(oid) as d from pg_constraint
           where conrelid = 'appointments'::regclass and contype = 'x' loop
    def := c.d;
    fixed := regexp_replace(def, 'WHERE \(.*\)$', $w$WHERE ((status = ANY (ARRAY['booked'::text, 'arrived'::text, 'completed'::text])))$w$);
    if fixed = def then
      raise exception 'appointments exclusion constraint % has no WHERE to rewrite: %', c.conname, def;
    end if;
    execute format('alter table appointments drop constraint %I', c.conname);
    execute format('alter table appointments add constraint %I %s', c.conname, fixed);
  end loop;
end $$;

alter table patients add column if not exists deleted_at timestamptz;
alter table patients add column if not exists deleted_by text;
-- a deleted record has no phone number left: the rule that every record has one (0020) now holds for every record
-- that is not deleted. NOT VALID as before, so the records from before v0.5 are still left alone.
alter table patients drop constraint if exists patients_phone_required;
alter table patients add constraint patients_phone_required check (deleted_at is not null or (phone_enc is not null and phone_hash is not null)) not valid;

-- a merge removes the record it merged away (its search keys go with it, on delete cascade): the app role may now delete it
grant delete on patients to attendra_app;

-- Request notes stay append-only for the app (no update, no delete: 0006). The one way a note goes is this: the notes
-- on the requests of a record already deleted, in the clinic the request is in (app.clinic_id, as withClinic sets it).
-- Runs as the owner, returns how many went, and only attendra_app may call it: inside withClinic, never outside a clinic.
create or replace function delete_notes_of_deleted_patients(p_task_ids uuid[])
  returns integer
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  n integer;
begin
  delete from public.task_notes nt
  using public.tasks t, public.patients p
  where nt.task_id = t.id and nt.clinic_id = t.clinic_id
    and t.id = any(p_task_ids)
    and t.clinic_id = current_setting('app.clinic_id', true)
    and p.id = t.patient_id and p.clinic_id = t.clinic_id and p.deleted_at is not null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function delete_notes_of_deleted_patients(uuid[]) from public;
grant execute on function delete_notes_of_deleted_patients(uuid[]) to attendra_app;

-- Rollback (every visit marked since is put back to booked, and no patient may be deleted again):
--   update appointments set status = 'booked' where status in ('arrived', 'completed', 'no_show');
--   alter table appointments drop constraint appointments_status_check;
--   alter table appointments add constraint appointments_status_check check (status in ('booked', 'cancelled'));
--   (the exclusion constraint: the same DO block with WHERE ((status = 'booked'::text)))
--   alter table appointments drop column status_changed_at, drop column status_changed_by;
--   revoke delete on patients from attendra_app; drop function delete_notes_of_deleted_patients(uuid[]);
--   alter table patients drop constraint patients_phone_required;
--   alter table patients add constraint patients_phone_required check (phone_enc is not null and phone_hash is not null) not valid;
--   alter table patients drop column deleted_at, drop column deleted_by;
