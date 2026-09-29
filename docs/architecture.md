# Architecture

Attendra splits a phone call between two systems on purpose. GPT-Live holds the conversation: it listens, speaks, handles interruptions and decides when it needs help. Our backend holds the facts and the rules: who the caller is, what is free, what the caller agreed to, what is written, and who is told. The model never touches data directly.

## Paths

**Audio** goes Caller → PSTN → Twilio → Elastic SIP Trunk (TLS signalling, SRTP media) → `sip.api.openai.com`. On this direct-SIP path call audio never passes through our servers.

**Control** goes OpenAI → our webhook (`POST /webhooks/openai`) for the incoming call, then a sideband WebSocket (`/v1/live/sessions/{id}/attach`) for the rest of the call: transcripts, delegations, and our appends back.

## Components

| Component | Job |
|---|---|
| `apps/voice` | Verifies the webhook, de-duplicates deliveries, resolves the clinic from the dialled number, accepts or rejects, and starts a `CallRunner`. Answers 200 fast; the call is handled after. |
| `CallRunner` (`packages/voice-engine`) | The single owner of every side effect for one session. Drops replayed events by `event_id`, stores whole transcript turns, sends appends, performs transfers and hang-ups, records final usage on `session.closed`. |
| `CallAgent` (`packages/agent`) | The per-call brain. Holds no socket and no timers, so the same object runs under GPT-Live, a future Realtime engine, and the simulator. |
| `runTool` (`packages/agent`) | Where the rules are. Every tool call the planner makes goes through it. |
| Planner | Decides which tools to call for one delegation and what the result sentence is. `ResponsesPlanner` in production; `ScriptedPlanner` in tests and scripted evals. |
| `packages/core` | Pure rules with no I/O: clinic config, hours, slots, routing, identity parsing, confirmation, emergency phrases, and the ports the backend implements. |
| `packages/db` | SQL migrations, RLS, PHI encryption, repositories implementing the ports. |
| `apps/api` | The dashboard API (NestJS on Fastify). Better Auth handles sign-in, sessions and two-factor under `/api/auth`; every `/api/v1` route passes `StaffGuard`, then reads and writes through `FrontDeskRepository` inside the clinic's scope. OpenAPI at `/api/docs`. |
| `apps/web` | The staff dashboard (Next.js, Tailwind, TanStack Query). It proxies `/api` to the API, so the browser only ever talks to one origin. |

## A delegation, in detail

1. GPT-Live sends `session.delegation.created` with a delegation id. It carries no task text; we rebuild the request from our own transcript and `CallState`.
2. `CallAgent.onDelegation` bumps the task revision and sends a `session.thinking.append` ("Working on it") so the model can keep the caller company.
3. The planner calls tools. `runTool` checks identity, offered slots, confirmations and idempotency before anything is read or written.
4. If a newer delegation started meanwhile, this result is dropped. Otherwise the result goes back as `session.commentary.append` for the model to say, capped well below the 500-token limit per append.

The emergency guardrail is not a delegation. It runs on every `session.input_transcript.delta`, over a rolling window of the caller's recent words, and appends a fixed `session.instructions.append` with `delegation_id: null` the moment it matches.

## The dashboard

A request from the browser goes to the dashboard's own origin; Next forwards `/api` to `apps/api`. The session cookie is first-party and `SameSite=Lax`, and on top of that every write must carry the dashboard's own `Origin`.

`StaffGuard` then checks, in order: the session is valid; the person has two-factor on (skipped only in demo mode); on a clinic route, the person belongs to the clinic's organization and their role has the route's permission (the table is in `apps/api/src/access.ts`). A clinic someone does not belong to answers 404, so ids cannot be probed. After the guard, everything runs as `attendra_app` inside `withClinic`, like the voice path.

Reading a transcript or a task is a PHI access and writes an audit row in the same transaction as the read. The call list carries no patient data at all.

The schedule (`/clinics/:clinicId/appointments`) reads through `ScheduleRepository` in `packages/db` and writes through `StaffScheduler` in `packages/scheduling`. A staff booking is checked by `slotProblem`, which asks the same slot search the assistant's `find_slots` runs whether it would offer that time, and is written by `insertAppointment`, the function `BuiltinScheduler` uses for the assistant's bookings. The exclusion constraint on `appointments` is the last word on double booking for both. `GET /appointments/slots` returns open times with no patient data; every other schedule route shows names and is audited.

Patients (`/clinics/:clinicId/patients`) go through `PatientRecords`. Search is a `POST` with the query in the body; names and dates of birth are decrypted and matched in the API, a full phone number goes through its keyed hash ([decision 7](decisions/0007-patient-search.md)). Adding or editing a patient writes the same `lookup_hash` and `phone_hash` the voice agent looks callers up by. When the agent verifies a caller, the tool action that did it also sets `calls.patient_id` in the same transaction; that link is what lists a patient's calls.

## Data

Postgres 16 is the only store. Every clinic table has `clinic_id` and a Row Level Security policy; requests run as a role that cannot bypass it, inside a transaction that sets the clinic. Names, dates of birth, phone numbers, transcript text, task details and appointment notes are encrypted in the application with AES-256-GCM; lookups use keyed HMACs. The audit log is append-only by grant. Details: [decisions/0003-tenancy-and-phi.md](decisions/0003-tenancy-and-phi.md).
