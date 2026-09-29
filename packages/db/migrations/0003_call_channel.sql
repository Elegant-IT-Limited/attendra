-- Attendra schema v3: where a call came from. 'phone' is a call over the SIP trunk;
-- 'web' is a test call a staff member made from the dashboard with their microphone.
alter table calls
  add column channel text not null default 'phone' check (channel in ('phone', 'web'));
