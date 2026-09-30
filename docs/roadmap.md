# Roadmap

Plans change with what pilots teach us; this is the current order.

## v0.1

Inbound calls over direct SIP, identity check, built-in scheduler, two-step writes, emergency guardrail, refill and callback tasks, SMS confirmations, RLS and encrypted PHI, the redacting logger, 15 call scenarios in CI.

## v0.2: the front desk

- `apps/api` (NestJS): sign-in with Better Auth, organizations and four roles, TOTP two-factor required, the call, task, settings and audit APIs, OpenAPI.
- `apps/web` (Next.js): past calls with transcript and every tool step, the task queue with claim and done, clinic settings with the same validation the voice service uses, the audit log.
- Demo mode: `pnpm demo` runs everything in one process with a week of calls played through the real agent.

## v0.3: the working front desk

Test calls from the browser over WebRTC; the Schedule with staff booking; Today; Patients; member management; requests with notes, outcomes and assignment; calls with filters and caller names.

## v0.4: the AI layer (done)

- One design system across the dashboard: tokens, dark mode, a component kit, a command palette and keyboard shortcuts, axe checks on every page.
- The clinic's own assistant: a name, and English and Spanish, with the guardrails and the yes check in every language.
- `apps/worker` on pg-boss: a summary of every call, the retention purge, text delivery statuses.
- Live calls: watch, coach the assistant, take over or end, with simulated calls for the demo.
- The clinic's knowledge: documents, hybrid search with pgvector, grounded and cited answers, medical questions refused in code.
- Webhooks for n8n, Zapier and Make, signed per Standard Webhooks.
- Quality: the weekly page, a judge for live evals, and simulated callers.
- `apps/mcp`: other AI agents can work with the front desk, with scoped, expiring API keys.

## v0.5: the revenue release (next)

Once Twilio is live:

- Reminder calls and texts, with consent recorded and an opt-out that is honoured everywhere.
- No-show recovery: a call or text after a missed visit, offering a new time.
- A waitlist that fills cancelled slots, asking the next patient first.

## Then

- Voice simulations: the simulated callers of v0.4, speaking, against GPT-Live.
- EHR adapters: NexHealth Synchronizer first (athenahealth, eClinicalWorks, NextGen, DrChrono), then FHIR R4 with SMART Backend Services.
- Later: the `gpt-realtime` engine behind the same `VoiceEngine` interface and a Twilio Media Streams bridge for self-hosters; clinic sign-up and billing for hosted deployments; insurance eligibility; a custom voice per clinic.
