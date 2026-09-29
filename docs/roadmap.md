# Roadmap

Plans change with what pilots teach us; this is the current order.

## v0.1

Inbound calls over direct SIP, identity check, built-in scheduler, two-step writes, emergency guardrail, refill and callback tasks, SMS confirmations, RLS and encrypted PHI, the redacting logger, 15 call scenarios in CI.

## v0.2: the front desk (now)

- `apps/api` (NestJS): sign-in with Better Auth, organizations and four roles, TOTP two-factor required, the call, task, settings and audit APIs, OpenAPI.
- `apps/web` (Next.js): past calls with transcript and every tool step, the task queue with claim and done, clinic settings with the same validation the voice service uses, the audit log.
- Demo mode: `pnpm demo` runs everything in one process with a week of calls played through the real agent.

Moved to v0.3: live calls and take-over in the dashboard, `apps/worker` (post-call summaries, retention purge, SMS status), voicemail with transcription, warm transfer, member management in the dashboard, single sign-on.

## v0.3: reach

- The `gpt-realtime` engine behind the same `VoiceEngine` interface, and a Twilio Media Streams bridge for self-hosters who want audio on their own servers.
- Outbound reminder calls through the Twilio partner integration.
- Spanish.
- Knowledge retrieval over longer clinic documents with pgvector.
- 40+ call scenarios, and a nightly end-to-end run over SIP with synthetic voices.

## Later

- EHR adapters: NexHealth Synchronizer first (athenahealth, eClinicalWorks, NextGen, DrChrono), then FHIR R4 with SMART Backend Services.
- Insurance eligibility hook; custom voice per clinic; analytics (containment, bookings, missed-call recovery, cost per call).
