-- Attendra schema v33: reminder consent on the record, reminders and confirmations on
-- the visit, and the reason when the front desk books outside the hours.
alter table patients
  add column if not exists sms_consent_at timestamptz,
  add column if not exists sms_consent_source text;          -- 'call' | 'staff' | 'import'
alter table appointments
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists reminder_sms_id uuid,
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_via text,               -- 'text' | 'staff'
  add column if not exists override_reason text;
create index if not exists appointments_reminder_due on appointments (clinic_id, starts_at) where status = 'booked' and reminder_sent_at is null;
