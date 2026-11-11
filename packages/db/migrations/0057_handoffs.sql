-- Attendra schema v57: the handoff review loop (note 47, alpha exception 2026-11-11).
--
-- handoffs   one row each time the assistant handed a call to the clinic's team or had no answer: a request, a
--            callback, a transfer, an emergency, or no answer. Codes only (core handoffs.ts): the kind, a fixed reason,
--            the tool steps before it with their result codes, which fixed assistant line was used (its id, never its
--            text), the engine and the channel. The caller's words stay in the encrypted transcript.
--            excerpt_enc (Level 2) is a short excerpt around that moment, masked BEFORE it is stored (names, numbers to
--            the last 4, emails, street addresses) and encrypted with the data key; kept only for a clinic that allows
--            it (an internal test clinic, or one whose accepted terms include the review line). It is cleared with the
--            call's transcript by the retention purge, and the row goes with the call.
--            verdict and fix_category are the Attendra team's review in the back office (needed / not needed / the
--            answer was wrong; agent rule / clinic info missing / bug); every view and verdict is audited.
--
-- Same Row Level Security as the call's other rows: no clinic set, no row. Additive: older code ignores it.
create table if not exists handoffs (
  id            uuid primary key default gen_random_uuid(),
  clinic_id     text not null,
  call_id       uuid not null references calls(id) on delete cascade,
  at            timestamptz not null default now(),
  engine        text not null,
  channel       text not null,
  kind          text not null,
  reason        text not null,
  steps         jsonb not null default '[]'::jsonb,
  line_id       text,
  excerpt_enc   text,
  verdict       text,
  fix_category  text,
  reviewed_by   text,
  reviewed_at   timestamptz,
  constraint handoffs_kind check (kind in ('request', 'callback', 'transfer', 'emergency', 'no_answer')),
  constraint handoffs_reason check (reason in ('caller_asked_person', 'identity_not_verified', 'no_answer_in_clinic_info', 'policy_refusal', 'tool_error', 'out_of_scope', 'language', 'emergency')),
  constraint handoffs_channel check (channel in ('phone', 'web')),
  constraint handoffs_verdict check (verdict is null or verdict in ('needed', 'not_needed', 'answer_wrong')),
  constraint handoffs_fix_category check (fix_category is null or fix_category in ('agent_rule', 'clinic_info_missing', 'bug')),
  constraint handoffs_reviewed check ((verdict is null) = (reviewed_at is null))
);
create index if not exists handoffs_by_clinic on handoffs (clinic_id, at desc, id desc);
create index if not exists handoffs_by_call on handoffs (clinic_id, call_id);
create index if not exists handoffs_not_needed on handoffs (clinic_id, reviewed_at) where verdict = 'not_needed';

grant select, insert, update on handoffs to attendra_app;
alter table handoffs enable row level security;
alter table handoffs force row level security;
create policy handoffs_clinic on handoffs using (clinic_id = current_setting('app.clinic_id', true)) with check (clinic_id = current_setting('app.clinic_id', true));

-- Rollback:
--   drop table if exists handoffs;
