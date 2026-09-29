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
| `apps/worker` | Background jobs on pg-boss, in the same Postgres: a summary of every call, the nightly retention purge, and (behind a flag) text delivery statuses. |

## A delegation, in detail

1. GPT-Live sends `session.delegation.created` with a delegation id. It carries no task text; we rebuild the request from our own transcript and `CallState`.
2. `CallAgent.onDelegation` bumps the task revision and sends a `session.thinking.append` ("Working on it") so the model can keep the caller company.
3. The planner calls tools. `runTool` checks identity, offered slots, confirmations and idempotency before anything is read or written.
4. If a newer delegation started meanwhile, this result is dropped. Otherwise the result goes back as `session.commentary.append` for the model to say, capped well below the 500-token limit per append.

The emergency guardrail is not a delegation. It runs on every `session.input_transcript.delta`, over a rolling window of the caller's recent words, and appends a fixed `session.instructions.append` with `delegation_id: null` the moment it matches.

## Live calls

Staff can watch a call as it happens, send the assistant a note, take the call, or end it.

```mermaid
sequenceDiagram
  participant Caller
  participant Voice as Voice service (CallRunner, CallAgent)
  participant Registry as Live registry (in memory)
  participant API as Dashboard API
  participant Staff as Browser
  Caller->>Voice: speech, as transcript deltas
  Voice->>Registry: captions, tool steps, state, emergency
  Staff->>API: GET /calls/:id/live (EventSource)
  API->>Voice: GET /internal/live/:id (token)
  Registry-->>API: snapshot, replay since Last-Event-ID, then new events
  API-->>Staff: the same stream, audited once as call.live.watched
  Staff->>API: POST /live/coach, /take-over or /end, with a key per click
  API->>Voice: the action (token), audited as call.coached, call.taken_over or call.ended_by_staff
  Voice->>Caller: an instruction to the voice model, then a transfer or a hang-up
```

`CallAgent` emits a `LiveEvent` for every caption delta, every tool step as it starts and finishes (the tool's name and its result code, never argument values), each change to the verified caller, the pending read-back and what the assistant is doing, an emergency, a staff action, and the end. The voice service keeps them in a `LiveRegistry`: the calls running now, per clinic, each with a replay buffer of its last 2,000 events. A watcher gets a snapshot of where the call stands, the buffer after its `Last-Event-ID`, then each new event, with a heartbeat every 15 seconds. A finished call stays in the registry for a minute, so a watcher still sees how it ended.

A coaching note reaches the voice model as an instruction marked as coming from staff. It changes nothing in code: `runTool` still refuses a booking without a read-back and a clear yes, a patient action before verification, and anything after an emergency, whatever the model does with the note. A take-over and an end are claims: the first one wins, the same click sent twice is the same claim, and anyone else is told who has the call. A browser test call cannot be transferred.

**One voice instance.** The registry lives in the voice service's memory, so the API must reach the instance that runs the call. That is the deployment Attendra supports today: one voice service. To run several, move the registry to Postgres. Each voice instance writes its events to a table keyed by call and event id, with the clinic's Row Level Security like any other call row, and sends a `NOTIFY` that carries only the call id and the new event id, because any database role can `LISTEN` on any channel. The API `LISTEN`s, reads the new rows inside `withClinic`, and streams them as today; `Last-Event-ID` becomes a query on the table. Staff actions become rows that the instance running the call picks up on its own channel. The HTTP contract to the browser does not change.

Simulated calls (`SimulatedEngine` in `packages/voice-engine`) play a scripted conversation into the real runner, agent, tools and database, with no audio and no model. The local demo turns them on so Live now has something to show without a phone or a key, and the e2e suite uses them to watch, coach and end a call.

## After a call

When a call closes, the voice service enqueues a `call.completed` job. The job's id is derived from the call id, so a second close, a retried webhook or a restart is still one job. The worker picks it up and queues the work every closed call needs; today that is `summarise-call`.

`summarise-call` reads the transcript and what the tools did (an audited PHI read), and asks the Responses API for a structured summary: two or three sentences for staff, the caller's intent, their sentiment, whether the call needs review and why, and a suggested follow-up. The output must match a strict JSON schema and is checked again with zod; an emergency call is always flagged, whatever the model says. The summary is encrypted into `call_summaries`, once per call, and the write is audited. Without an OpenAI key the worker writes the same shape from the call's facts alone, with no model.

A job that fails is retried with exponential backoff (15 seconds up to an hour, five times) and then moved to a dead-letter queue, where nothing retries it. Job data holds ids only, never patient data, and a failure is kept as a code (`summary_model_http_503`), never a message that could echo the transcript. The `worker_jobs` view shows each clinic its own jobs, and the call page says when a summary is still coming or could not be written.

`purge-retention` runs at 03:00 UTC. For each clinic it deletes transcripts and summaries of calls older than the clinic's `retentionDays` (2555 by default, about 7 years) and audits how many it deleted, never what. It runs as the database owner, like the migrations; the application role cannot delete call records.

## The dashboard

A request from the browser goes to the dashboard's own origin; Next forwards `/api` to `apps/api`. The session cookie is first-party and `SameSite=Lax`, and on top of that every write must carry the dashboard's own `Origin`.

`StaffGuard` then checks, in order: the session is valid; the person is not still on a temporary password (only `/me` answers until they change it); the person has two-factor on (skipped only in demo mode); on a clinic route, the person belongs to the clinic's organization and their role has the route's permission (the table is in `apps/api/src/access.ts`). A clinic someone does not belong to answers 404, so ids cannot be probed. After the guard, everything runs as `attendra_app` inside `withClinic`, like the voice path.

Reading a transcript or a task is a PHI access and writes an audit row in the same transaction as the read. A viewer's call list carries no patient data at all; for roles that may read calls it adds the verified caller's name, and that view is audited.

The schedule (`/clinics/:clinicId/appointments`) reads through `ScheduleRepository` in `packages/db` and writes through `StaffScheduler` in `packages/scheduling`. A staff booking is checked by `slotProblem`, which asks the same slot search the assistant's `find_slots` runs whether it would offer that time, and is written by `insertAppointment`, the function `BuiltinScheduler` uses for the assistant's bookings. The exclusion constraint on `appointments` is the last word on double booking for both. `GET /appointments/slots` returns open times with no patient data; every other schedule route shows names and is audited.

Patients (`/clinics/:clinicId/patients`) go through `PatientRecords`. Search is a `POST` with the query in the body; names and dates of birth are decrypted and matched in the API, a full phone number goes through its keyed hash ([decision 7](decisions/0007-patient-search.md)). Adding or editing a patient writes the same `lookup_hash` and `phone_hash` the voice agent looks callers up by. When the agent verifies a caller, the tool action that did it also sets `calls.patient_id` in the same transaction; that link is what lists a patient's calls.

## Data

Postgres 16 is the only store. Every clinic table has `clinic_id` and a Row Level Security policy; requests run as a role that cannot bypass it, inside a transaction that sets the clinic. Names, dates of birth, phone numbers, transcript text, task details and appointment notes are encrypted in the application with AES-256-GCM; lookups use keyed HMACs. The audit log is append-only by grant. Details: [decisions/0003-tenancy-and-phi.md](decisions/0003-tenancy-and-phi.md).
