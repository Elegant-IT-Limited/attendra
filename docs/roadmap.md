# Roadmap

Plans change with what pilots teach us; this is the current order.

## v0.1

Inbound calls over direct SIP, identity check, built-in scheduler, two-step writes, emergency guardrail, refill and callback tasks, SMS confirmations, RLS and encrypted PHI, the redacting logger, 15 call scenarios in CI.

## v0.2: the front desk

- `apps/api` (NestJS): sign-in with Better Auth, organizations and four roles, TOTP two-factor required, the call, task, settings and audit APIs, OpenAPI.
- `apps/web` (Next.js): past calls with transcript and every tool step, the task queue with claim and done, clinic settings with the same validation the voice service uses, the audit log.
- Demo mode: `pnpm demo` runs everything in one process with a week of calls played through the real agent.

## v0.3: the working front desk (now)

- Test calls from the browser over WebRTC (done).
- The Schedule: day and week views, staff booking, moving and cancelling with the assistant's rules, and the call page linked to what it booked (done).
- Today, the home screen: what needs attention, the day's appointments and what the assistant did (done).
- Patients: search, add and edit, a record with appointments, verified calls and requests, and calls linked to the verified patient (done).
- Live calls in the dashboard, and staff take-over.
- `apps/worker`: post-call summaries, retention purge, SMS status; voicemail with transcription.
- Member management in the dashboard.
- Clinic sign-up, billing and cost per call, for hosted deployments.

## v0.4: reach

- The `gpt-realtime` engine behind the same `VoiceEngine` interface, and a Twilio Media Streams bridge for self-hosters who want audio on their own servers.
- Outbound reminder calls through the Twilio partner integration.
- Spanish.
- Knowledge retrieval over longer clinic documents with pgvector.
- 40+ call scenarios, and a nightly end-to-end run over SIP with synthetic voices.

## Later

- EHR adapters: NexHealth Synchronizer first (athenahealth, eClinicalWorks, NextGen, DrChrono), then FHIR R4 with SMART Backend Services.
- Insurance eligibility hook; custom voice per clinic; analytics (containment, bookings, missed-call recovery, cost per call).
