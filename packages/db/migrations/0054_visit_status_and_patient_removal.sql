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

-- a merge removes the record it merged away (its search keys go with it, on delete cascade), and a delete
-- removes the notes on the deleted pet's requests: the app role may now delete both
grant delete on patients to attendra_app;
grant delete on task_notes to attendra_app;

-- Rollback (every visit marked since is put back to booked, and no patient may be deleted again):
--   update appointments set status = 'booked' where status in ('arrived', 'completed', 'no_show');
--   alter table appointments drop constraint appointments_status_check;
--   alter table appointments add constraint appointments_status_check check (status in ('booked', 'cancelled'));
--   (the exclusion constraint: the same DO block with WHERE ((status = 'booked'::text)))
--   alter table appointments drop column status_changed_at, drop column status_changed_by;
--   revoke delete on patients, task_notes from attendra_app;
--   alter table patients drop column deleted_at, drop column deleted_by;
