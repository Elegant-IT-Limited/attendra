-- Attendra schema v5: which patient a call was with.
--
-- Set when the voice agent verifies the caller by name and date of birth, never
-- from the calling number alone. It lets the dashboard list a patient's calls and
-- show a verified caller's name on the call list.
alter table calls add column patient_id uuid references patients(id);
create index calls_patient on calls (clinic_id, patient_id);
