-- Attendra schema v41: every request has its own number, and belongs to a household.
--
-- A number per clinic, R-1042, given in the order requests come in and never reused: a
-- counter row per clinic, advanced in the insert's own transaction, so two requests made at
-- the same moment get consecutive numbers. Requests already in the queue are numbered in the
-- order they came in. A request also carries the household it belongs to (the owner's phone,
-- as the keyed hash patients carry), so a pet's page and a search by number find it; the
-- requests already linked to a record take that record's number here, and a deploy step fills
-- the ones linked to a call from the call's number (the hash needs the data key).
-- tasks forces its row policy on every role, so the fill runs clinic by clinic, as the API does.
create table if not exists clinic_counters (
  clinic_id    text primary key references clinics(id) on delete cascade,
  next_request integer not null default 1
);
grant select, insert, update on clinic_counters to attendra_app;
alter table clinic_counters enable row level security;
alter table clinic_counters force row level security;
create policy clinic_counters_clinic on clinic_counters using (clinic_id = current_setting('app.clinic_id', true)) with check (clinic_id = current_setting('app.clinic_id', true));

alter table tasks add column if not exists number integer;
alter table tasks add column if not exists household_hash text;

do $$
declare c text;
begin
  for c in select id from clinics loop
    perform set_config('app.clinic_id', c, true);
    update tasks t set number = n.rn
      from (select id, row_number() over (order by created_at, id) as rn from tasks where clinic_id = c) n
      where t.id = n.id and t.clinic_id = c and t.number is null;
    update tasks t set household_hash = p.phone_hash
      from patients p
      where t.clinic_id = c and p.clinic_id = c and t.patient_id = p.id and t.household_hash is null and p.phone_hash is not null;
    insert into clinic_counters (clinic_id, next_request)
      select c, coalesce(max(number), 0) + 1 from tasks where clinic_id = c
      on conflict (clinic_id) do update set next_request = excluded.next_request;
  end loop;
  perform set_config('app.clinic_id', '', true);
end $$;

alter table tasks alter column number set not null;
create unique index if not exists tasks_clinic_number on tasks (clinic_id, number);
create index if not exists tasks_clinic_household on tasks (clinic_id, household_hash);
