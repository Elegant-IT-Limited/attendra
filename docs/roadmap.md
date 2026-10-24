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
- `apps/worker` on pg-boss: a summary of every call, the retention purge. Text delivery statuses have a worker handler, but nothing sends it jobs yet: Twilio's status callback is not wired.
- Live calls: watch, coach the assistant, take over or end, with simulated calls for the demo.
- The clinic's knowledge: documents, hybrid search with pgvector, grounded and cited answers, medical questions refused in code.
- Webhooks for n8n, Zapier and Make, signed per Standard Webhooks.
- Quality: the weekly page, a judge for live evals, and simulated callers.
- `apps/mcp`: other AI agents can work with the front desk, with scoped, expiring API keys.

## v0.5: doctors, families and a live dashboard (done)

From the first browser test calls:

- Doctors with specialties, what they see people for, ages, weekly hours, days off and new-patient status, on a page of their own and in CSV imports. The assistant describes them to any caller and reads them again before every request.
- Patients known by name, date of birth and phone together; families on one phone; new patients added on a call and checked by the front desk; doctors offered by the patient's age.
- Every screen updates as the clinic changes, every search answers as you type, the newest come first, and cancellations have a history of their own.
- The latest stack: Node 24, pnpm 12, Postgres 18, TypeScript 6, Next 16.3, NestJS 12.1.

## v0.6: industry packs (done)

- The engine and the trade are separate: an account picks an industry pack, which names things and adds the prompt lines that depend on the trade. The clinic is the first pack, with no change in behaviour. See [industries.md](industries.md).
- Test calls warn when the browser did not turn on echo cancellation or noise suppression.
- At most five new patients per phone number in a day; doctors' names in the clinic's other languages.

## v0.7: veterinary clinics (done)

A pack for veterinary practices: pets found by their owner and their own name, new pets added with their kind of animal and age, an animal emergency list in English and Spanish that sends callers to the clinic's emergency hospital, after-hours requests instead of bookings, and a demo veterinary clinic with 10 call scenarios.

## v0.8: the veterinary front desk (done)

Refill requests a vet approves before the owner is texted, records requests, the emergency hospital and after-hours settings in the dashboard, locations, custom fields, booking rules, visit reminders with consent, texts during calls, GPT Realtime as a second voice engine, accounts with two-step sign-in, MCP and webhooks on a hosted service, and calls that listen, ask one question at a time and offer real times first, tested on 78 call scenarios.

## v0.9: real phone lines (done)

Real calls on production phone numbers through an Elastic SIP trunk, a backup route that rings the clinic or says where to go when Attendra cannot take a call, texts with consent said on the call and limits that stop texting fraud, security rules enforced in code, Slack alerts and an outside uptime check, and fixes from the first real calls, tested on 110 call scenarios.

## v1.0: the first clinics (next)

The first clinics in the private beta on their own lines, texting approved by the carriers, and fixes from their calls.

## Revenue features

- No-show recovery: a call or text after a missed visit, offering a new time.
- A waitlist that fills cancelled slots, asking the next patient first.

## Then

- Voice simulations: the simulated callers of v0.4, speaking, against GPT-Live.
- EHR adapters: NexHealth Synchronizer first (athenahealth, eClinicalWorks, NextGen, DrChrono), then FHIR R4 with SMART Backend Services.
- Calendars and practice software: Google Calendar first, then ezyVet and Provet Cloud.
- Later: a Twilio Media Streams bridge for self-hosters; insurance eligibility; a custom voice per clinic.
