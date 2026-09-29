-- Attendra schema v8: a link between two clinic rows stays inside one clinic.
--
-- Row Level Security does not apply to foreign key checks, so until now only the
-- application stopped a call from naming another clinic's patient, or a note from
-- hanging off another clinic's request. Composite keys make the database refuse it.
alter table patients add constraint patients_clinic_id_id_key unique (clinic_id, id);
alter table tasks add constraint tasks_clinic_id_id_key unique (clinic_id, id);

alter table calls
  add constraint calls_patient_same_clinic foreign key (clinic_id, patient_id) references patients (clinic_id, id);
alter table task_notes
  add constraint task_notes_task_same_clinic foreign key (clinic_id, task_id) references tasks (clinic_id, id);
