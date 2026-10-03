-- Attendra schema v20: a patient is one person, known by name, date of birth and phone together.
--
-- Two people can share a name and a date of birth, and a family shares one phone (a
-- parent books for their children on the number they all use). The three together
-- name one person. identity_hash is a keyed hash of all three, unique in a clinic, so
-- the same person cannot be added twice, by the front desk, an import or the assistant.
--
-- It is computed in the application, which holds the key. Rows added before this
-- migration get theirs from `pnpm db:rehash-lookups`, which also lists the patients
-- who still have no phone number. Until then they can be found by staff but not
-- verified on a call.
alter table patients
  add column identity_hash     text,
  -- a parent or guardian, for a patient under 18. Encrypted like the other names
  add column guardian_name_enc text,
  -- new: added by the assistant on a call; the front desk checks the details and confirms
  add column status            text not null default 'active' check (status in ('active', 'new')),
  add column created_by_call_id uuid;

alter table patients add constraint patients_created_by_call_same_clinic
  foreign key (clinic_id, created_by_call_id) references calls (clinic_id, id);

create unique index patients_identity on patients (clinic_id, identity_hash) where identity_hash is not null;
create index patients_phone on patients (clinic_id, phone_hash);
create index patients_created on patients (clinic_id, created_at desc);

-- Every patient added or changed from now on has a phone number. NOT VALID leaves the
-- rows already there alone; the rehash command names them for the front desk.
alter table patients add constraint patients_phone_required check (phone_enc is not null and phone_hash is not null) not valid;

-- A request for staff to check a patient the assistant added closes with this outcome.
alter table tasks drop constraint if exists tasks_outcome_check;
alter table tasks add constraint tasks_outcome_check check (outcome in ('called_back', 'left_message', 'refill_sent', 'not_needed', 'details_confirmed'));
