-- Attendra schema v49: search keys in their own tables, so a search reads an index instead of the newest records.
--
-- Names, phones and dates of birth are encrypted (decision 7), so a search could only match what
-- it decrypted: the newest 20,000 patients, or the numbers of the newest 5,000 calls, on every
-- keystroke. These tables hold keyed HMACs (shortened to 12 characters; a key only says where to
-- look, and every candidate is still matched on its decrypted details) that a search looks up by
-- equality:
--   patient_search_keys  for each patient: the first one, two and three letters and the whole of
--                        every word of its own and its owner's name, the start of each word's sound,
--                        the date of birth, and the phone's start and every run of three to nine digits
--   call_search_keys     for each call with a number: the same digit runs of the number it came from
-- Each kind of key has its own form, so the start of a word never equals a whole word.
--
-- Why not the owner_words_hash array of migration 0042 and its GIN index: under Row Level Security,
-- Postgres uses an index only for leakproof operators, and the array overlap operator (&&) is not
-- one, so every search read the clinic's whole table. Equality on text is leakproof. The array is
-- still written as 0042 defined it, so the release before this one still finds what it found.
--
-- Filled by the repositories on every write, and for records already on file by
-- `pnpm db:rehash-lookups --apply` (it reports counts only). The retention purge deletes a call's
-- keys with its number.
create table if not exists patient_search_keys (
  clinic_id  text not null references clinics(id),
  key        text not null,
  patient_id uuid not null,
  primary key (clinic_id, key, patient_id),
  foreign key (clinic_id, patient_id) references patients (clinic_id, id) on delete cascade
);
create index if not exists patient_search_keys_patient on patient_search_keys (clinic_id, patient_id);
alter table patient_search_keys enable row level security;
alter table patient_search_keys force row level security;
create policy patient_search_keys_clinic on patient_search_keys
  using (clinic_id = current_setting('app.clinic_id', true))
  with check (clinic_id = current_setting('app.clinic_id', true));
grant select, insert, delete on patient_search_keys to attendra_app;

create table if not exists call_search_keys (
  clinic_id text not null references clinics(id),
  key       text not null,
  call_id   uuid not null,
  primary key (clinic_id, key, call_id),
  foreign key (clinic_id, call_id) references calls (clinic_id, id) on delete cascade
);
create index if not exists call_search_keys_call on call_search_keys (clinic_id, call_id);
alter table call_search_keys enable row level security;
alter table call_search_keys force row level security;
create policy call_search_keys_clinic on call_search_keys
  using (clinic_id = current_setting('app.clinic_id', true))
  with check (clinic_id = current_setting('app.clinic_id', true));
grant select, insert, delete on call_search_keys to attendra_app;
