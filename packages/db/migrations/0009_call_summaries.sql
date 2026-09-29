-- Attendra schema v9: a summary of every call, written by the worker.
--
-- The summary, the reason a call needs review and the suggested follow-up are free
-- text about a patient's call, so they are encrypted like the transcript. The intent,
-- the sentiment and the review flag are fixed codes the dashboard filters on, so they
-- stay in clear, like a call's outcome.
--
-- The application role reads summaries and marks them reviewed. Only the worker writes
-- them, and only the worker (as the owner, like migrations) deletes old ones.

create table call_summaries (
  call_id             uuid primary key references calls(id),
  clinic_id           text not null references clinics(id),
  body_enc            text not null, -- {summary, reviewReason, followUp}, encrypted
  intent              text not null check (intent in ('book', 'reschedule', 'cancel', 'refill', 'question', 'callback', 'emergency', 'other')),
  sentiment           text not null check (sentiment in ('calm', 'frustrated', 'distressed')),
  needs_review        boolean not null,
  model               text not null, -- the model that wrote it, or "local"
  created_at          timestamptz not null default now(),
  reviewed_at         timestamptz,
  reviewed_by_user_id text
);
create index call_summaries_review on call_summaries (clinic_id, created_at desc) where needs_review and reviewed_at is null;

alter table call_summaries enable row level security;
alter table call_summaries force row level security;
create policy call_summaries_clinic on call_summaries
  using (clinic_id = current_setting('app.clinic_id', true))
  with check (clinic_id = current_setting('app.clinic_id', true));
grant select, insert on call_summaries to attendra_app;
grant update (reviewed_at, reviewed_by_user_id) on call_summaries to attendra_app;

-- Counts for audit rows that record how much was done, never what: "412 transcript
-- lines and 9 summaries deleted". Never content.
alter table audit_logs add column counts jsonb;

-- Twilio's id for a sent text, so a delivery status can find its message.
alter table sms_messages add column provider_sid text;
create index sms_messages_provider_sid on sms_messages (provider_sid) where provider_sid is not null;
