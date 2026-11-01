-- Attendra schema v42: find a pet by its owner's name, or by the last digits of a phone, without plain text.
--
-- Names and phones are encrypted (decision 7), so a search can only read as many rows as it
-- decrypts. These two keyed lookups let it reach a record past that window the way the whole
-- phone number already does:
--   owner_words_hash   the keyed HMAC of every word of the owner's (guardian's) name and of the
--                      patient's own first and last name, folded and lower-cased
--   phone_suffix_hash  the keyed HMAC of the last four digits of the phone
-- Both are filled by the repository on every insert and update, and for records already on
-- file by `pnpm db:rehash-lookups` (the deploy runs it; it reports counts only).
alter table patients add column if not exists owner_words_hash text[];
alter table patients add column if not exists phone_suffix_hash text;
create index if not exists patients_owner_words_hash on patients using gin (owner_words_hash);
create index if not exists patients_phone_suffix_hash on patients (clinic_id, phone_suffix_hash);
