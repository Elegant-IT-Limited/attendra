-- A patient id with appointment times is PHI, so a receiver gets no patient ids unless
-- the clinic turns this off for that endpoint (and has a BAA with whoever runs it).
-- On for every endpoint, the ones that exist already included.
alter table webhook_endpoints add column omit_patient_ids boolean not null default true;
