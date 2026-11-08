-- Attendra schema v53: the cleaning time after a visit is protected by the database, and a
-- cancelled visit says when it was cancelled.
--
-- 1. blocks_until = ends_at + the visit type's buffer (Settings, Visit types, "minutes free
--    after"), worked out by the database itself on every insert and every change of time, vet
--    or visit type, from the clinic's settings at that moment. The double-booking exclusion now
--    covers [starts_at, blocks_until): two bookings racing each other can no longer land inside
--    a visit's cleaning time, whatever the application does. The slot search keeps the same rule
--    (packages/core/src/slots.ts, clashes). Cleaning time may run past closing (the window holds
--    the visit, not its buffer); that is the slot search's business, not this constraint's.
-- 2. cancelled_at: set by the cancel itself, so the cancelled history is ordered by when a visit
--    was cancelled, not by its last change. Rows cancelled before this keep their updated_at,
--    the best record there is.
alter table appointments
  add column if not exists blocks_until timestamptz,
  add column if not exists cancelled_at timestamptz;

-- The buffer a clinic's visit type keeps after it, in minutes: 0 for a type with none, or one no
-- longer in the settings. The writer's own rights: every write to appointments runs as that
-- clinic (row security), and so may read that clinic's settings.
create or replace function attendra_visit_buffer_minutes(clinic text, visit_type text) returns integer
  language sql stable set search_path = pg_catalog, public as $$
  select coalesce((
    select greatest(0, least(120, round((vt->>'bufferMinutes')::numeric)::integer))
    from clinics c, jsonb_array_elements(coalesce(c.config->'visitTypes', '[]'::jsonb)) vt
    where c.id = clinic and vt->>'id' = visit_type and jsonb_typeof(vt->'bufferMinutes') = 'number'
    limit 1), 0)
$$;

-- Every row's buffered end, by its type's buffer today.
update appointments a set blocks_until = a.ends_at + make_interval(mins => attendra_visit_buffer_minutes(a.clinic_id, a.visit_type_id));
-- Booked visits already inside each other's buffer (booked before the buffer was set, or longer
-- since) keep only their own time, so the stricter constraint holds for what is already booked.
-- One statement: both visits of such a pair are found against the values before it.
update appointments a set blocks_until = a.ends_at
where a.status = 'booked' and exists (
  select 1 from appointments o
  where o.id <> a.id and o.status = 'booked' and o.clinic_id = a.clinic_id and o.provider_id = a.provider_id
    and tstzrange(o.starts_at, o.blocks_until) && tstzrange(a.starts_at, a.blocks_until));
alter table appointments alter column blocks_until set not null;
alter table appointments add constraint appointments_blocks_until_after_end check (blocks_until >= ends_at);

update appointments set cancelled_at = updated_at where status = 'cancelled' and cancelled_at is null;

-- Set on every write, never by the application: the buffered end when a visit is booked or its time, vet or visit
-- type changes (by the buffer then); any other change keeps it as it was, so a later change of the buffer in Settings
-- never makes an unrelated update (a reminder sent, a note) fail on the constraint. And when a visit is cancelled,
-- the moment of the cancel if the write did not say.
create or replace function attendra_appointment_derived() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
     or new.provider_id is distinct from old.provider_id or new.visit_type_id is distinct from old.visit_type_id or new.clinic_id is distinct from old.clinic_id then
    new.blocks_until := new.ends_at + make_interval(mins => attendra_visit_buffer_minutes(new.clinic_id, new.visit_type_id));
  else
    new.blocks_until := old.blocks_until;
  end if;
  if new.status = 'cancelled' and new.cancelled_at is null and (tg_op = 'INSERT' or old.status is distinct from 'cancelled') then
    new.cancelled_at := now();
  end if;
  return new;
end $$;
create trigger appointments_derived before insert or update on appointments for each row execute function attendra_appointment_derived();

-- The last line of defence against double booking, now with the buffer: two booked visits for
-- one provider can never overlap, nor one start inside the other's cleaning time.
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'appointments'::regclass and contype = 'x' loop
    execute format('alter table appointments drop constraint %I', c.conname);
  end loop;
end $$;
alter table appointments add constraint appointments_no_overlap
  exclude using gist (clinic_id with =, provider_id with =, tstzrange(starts_at, blocks_until) with &&) where (status = 'booked');

-- Rollback:
--   alter table appointments drop constraint appointments_no_overlap;
--   alter table appointments add exclude using gist (clinic_id with =, provider_id with =, tstzrange(starts_at, ends_at) with &&) where (status = 'booked');
--   drop trigger appointments_derived on appointments; drop function attendra_appointment_derived(); drop function attendra_visit_buffer_minutes(text, text);
--   alter table appointments drop constraint appointments_blocks_until_after_end, drop column blocks_until, drop column cancelled_at;
