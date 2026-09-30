-- A call's summary belongs to the same clinic as the call. Row Level Security does not
-- apply to foreign key checks, so the composite key makes the database refuse a
-- summary filed under another clinic, as 0008 does for the other clinic links.
alter table calls add constraint calls_clinic_id_id_key unique (clinic_id, id);
alter table call_summaries
  add constraint call_summaries_call_same_clinic foreign key (clinic_id, call_id) references calls (clinic_id, id);
