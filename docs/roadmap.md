# Roadmap

Plans change with what pilots teach us; this is the current order.

## v0.1 (now)

Inbound calls over direct SIP, identity check, built-in scheduler, two-step writes, emergency guardrail, refill and callback tasks, SMS confirmations, RLS and encrypted PHI, the redacting logger, 15 call scenarios in CI.

## v0.2: the front desk

- `apps/api` (NestJS): auth with organisations and roles, TOTP 2FA for staff, clinic configuration, call and task APIs.
- `apps/web` (Next.js): live and past calls with transcript and outcome, the task queue, clinic settings, take-over of a live call.
- `apps/worker` (BullMQ on Redis): post-call summaries, retention purge, SMS status.
- Voicemail with transcription; warm transfer.

## v0.3: reach

- The `gpt-realtime` engine behind the same `VoiceEngine` interface, and a Twilio Media Streams bridge for self-hosters who want audio on their own servers.
- Outbound reminder calls through the Twilio partner integration.
- Spanish.
- Knowledge retrieval over longer clinic documents with pgvector.
- 40+ call scenarios, and a nightly end-to-end run over SIP with synthetic voices.

## Later

- EHR adapters: NexHealth Synchronizer first (athenahealth, eClinicalWorks, NextGen, DrChrono), then FHIR R4 with SMART Backend Services.
- Insurance eligibility hook; custom voice per clinic; analytics (containment, bookings, missed-call recovery, cost per call).
