# Attendra

**An open-source AI receptionist for medical practices.** It answers the clinic's phone line day and night, in English, Spanish and Bangla, verifies the caller, books, moves and cancels appointments, takes refill and callback requests, answers everyday questions from the clinic's own FAQ and documents, and hands anything clinical or urgent to a person. Staff watch calls live, coach the assistant or take over, and read a summary of every call.

Twilio carries the call over SIP to OpenAI GPT-Live, which holds the conversation. Every decision that matters (who the caller is, which times are really free, whether the caller said yes, what gets written, who is told) runs in this repository's TypeScript backend, where it can be tested, audited and self-hosted.

> **Status: v0.4, pre-pilot.** The call path, the backend brain, the scheduler, the dashboard, live calls, summaries, the clinic's knowledge, webhooks, quality tracking and MCP work and are tested. Reminders and the waitlist come next, once Twilio is live (see the [roadmap](docs/roadmap.md)). Attendra is *HIPAA-ready*, not HIPAA-certified: you need BAAs with your providers before any real patient data goes through it. Read [docs/hipaa.md](docs/hipaa.md) first.

## One call, end to end

At 8 pm Maria calls the clinic about knee pain.

1. Twilio receives the call and sends it over an Elastic SIP Trunk to `sip.api.openai.com`.
2. OpenAI sends `live.transport.incoming` to `apps/voice`. We verify the signature, drop duplicate deliveries, find the clinic from the dialled number and accept with its greeting, hours and voice.
3. We attach to the call's sideband socket. Every caller transcript fragment goes through the emergency guardrail before anything else.
4. Maria asks for an appointment. GPT-Live delegates to our backend, which verifies her name and date of birth, finds real openings and offers three.
5. She picks one. The backend stages the booking and returns the read-back. The booking is written only after Maria's own words contain a clear yes, and the write carries an idempotency key, so a retried delegation cannot book twice.
6. She gets one confirmation text at the number on her record. The call, the transcript (encrypted) and every tool action are stored, and the front desk sees them in the dashboard a few seconds after she hangs up.

Had Maria said "I have chest pain", the backend would have stopped the task (any pending change is dropped and further writes are refused), told her to hang up and call 911, and, if the clinic enabled it, transferred the call to the on-call line a few seconds later. It never gives medical advice.

```
Caller ─PSTN─▶ Twilio ─Elastic SIP (TLS/SRTP)─▶ OpenAI GPT-Live ◀─sideband WS─┐
                                                     │                          │
                             webhook live.transport.incoming                     │
                                                     ▼                          │
                                  apps/voice (Fastify) ── CallRunner ───────────┘
                                                     │
                                  packages/agent: CallAgent + runTool (the rules)
                                     │            │             │           │
                              scheduling      identity      tasks, SMS     audit
                                     └────────── Postgres 16, RLS, encrypted PHI ──┘
```

## What it does

- **Answers calls** over Twilio SIP and GPT-Live, or from the browser for testing, with the clinic's hours, providers, visit types, routing and greeting.
- **Speaks the caller's language**: English, Spanish, and Bangla (experimental), with a name for the assistant and the AI disclosure checked in every language. [docs/languages.md](docs/languages.md)
- **Books, moves and cancels** only after a read-back and a clear yes; takes refills and callbacks as requests for staff.
- **Answers from the clinic's own documents**, with citations, and refuses medical questions in code. [Decision 8](docs/decisions/0008-clinic-knowledge.md)
- **Live calls**: staff see captions and every tool step as they happen, send the assistant a note, take the call or end it.
- **Summarises every call** for staff, flags the ones that need a look, and deletes old records on the clinic's retention period.
- **Webhooks** for n8n, Zapier and Make, signed per Standard Webhooks, with no patient data in them. [docs/webhooks.md](docs/webhooks.md)
- **Quality**: a weekly page of containment, bookings, refusals and cost, a judge for live evals, and simulated callers. [docs/quality.md](docs/quality.md)
- **MCP**: other AI agents, such as a desktop MCP client, can read the schedule and requests and close requests with a scoped key, and can never book or cancel. [docs/mcp.md](docs/mcp.md)
- **The front desk dashboard**: Today, the schedule, patients, requests, calls, team, settings and the audit log, in light and dark, with a command palette. [docs/design.md](docs/design.md)

## How the AI works

Four models do four jobs, and none of them decides anything that matters on its own.

1. **GPT-Live holds the conversation.** It hears the caller, speaks, and decides when it needs help. When it does, it delegates to our backend. It sees clinic facts and short results, never records.
2. **The planner picks the tools.** For each delegation, a Responses API model reads the conversation and calls our tools: verify the caller, find slots, propose a booking, search the clinic's documents. Every tool call goes through `runTool`, where the rules live in code: identity first, only offered slots, a read-back and a clear yes before any write, no medical advice, nothing after an emergency. A tool can refuse, and the planner is told why.
3. **Guardrails run without a model.** The emergency phrase list, the yes check and the medical-question check are code, in every language, on every caller turn. No prompt, coaching note or document can turn them off.
4. **After the call, a model summarises it** for staff, from the transcript, with its output checked against a schema. Documents are embedded for search; judges and simulated callers test the whole thing offline and in the manual quality workflow.

Every model call is made with `store: false`, a model name from the environment, a timeout and a ceiling on output, and every one is replaced by a fixed stand-in in the tests, so CI never calls OpenAI.

## What is enforced in code, not in a prompt

Prompts guide the voice. The rules below live in [`packages/agent/src/tools.ts`](packages/agent/src/tools.ts) and [`packages/core`](packages/core/src), and each has a test that tries to break it:

| Rule | Where | Proven by |
|---|---|---|
| Nothing patient-specific before a name and date-of-birth match | `runTool` | `identity_required` in agent tests and the `no-identity-no-records` scenario |
| Only slots the caller was actually offered can be booked | `CallState.offered` | `invented-slot` scenario |
| No write without a spoken read-back and a clear yes to it in the caller's own words | `CallState.answerToReadback`, `commit_pending` | `hedge-is-not-yes` scenario, "yes before the read-back" test |
| Every write is idempotent; the database refuses overlapping bookings | idempotency keys, a Postgres exclusion constraint | scheduler tests |
| An outdated request can neither write nor speak | task revisions in `CallAgent` and `runTool` | "discards a slow result" and "refuses the writes" tests |
| The emergency guardrail runs on every caller fragment, keeps listening after the first match, and cannot be turned off | `detectEmergencies`, `CallAgent.onCallerTranscript` | `emergency-chest-pain`, `self-harm-language`, `not-an-emergency` |
| Refills and callbacks become staff tasks, never decisions | `create_refill_request` | `refill-request` scenario |
| Clinics cannot see each other's data, even through a query with no filter | Postgres Row Level Security | `tenancy-and-phi.test.ts` |
| Names, dates of birth, phone numbers and transcripts are encrypted at rest and never logged | `createPhiCipher`, the redacting logger | `redaction.test.ts`, the ciphertext test |
| Staff need two-factor before any clinic data; a viewer never sees a transcript; another clinic's data is a 404 | `StaffGuard`, `apps/api/src/access.ts` | `apps/api/test/api.test.ts` |
| Every transcript and task view is audited in the same transaction as the read | `FrontDeskRepository` | `front-desk.test.ts` |

## Quick start

You need Node 22 and pnpm 10.

```bash
pnpm install
pnpm test        # unit, Postgres integration (in-process) and the call scenarios
pnpm eval        # the call scenarios as a readable report
```

No keys are needed for either. The scenarios run the real backend against a real Postgres, with a scripted planner standing in for the model; the scripts deliberately try things the backend must refuse. `pnpm eval --live` runs the same calls with the real planner model, and `--judge` scores them (both need `OPENAI_API_KEY` and cost credit).

### See the dashboard

```bash
pnpm demo        # then open http://localhost:3000
```

This starts the API on an in-memory Postgres, plays every call scenario through the real agent into it as a week of calls at each demo clinic, fills three weeks of the calendar around today, and starts the dashboard: Today (what needs someone, the day's appointments and what the assistant did), the calls, the schedule (book, move and cancel with the same rules the assistant uses), patients (search, add, and each patient's visits, calls and requests), refill and callback requests with notes and outcomes, the team, settings and the audit log. Sign in as `manager@maple-demo.test` (practice manager) or `frontdesk@maple-demo.test` (front desk) at Maple Street Family Medicine, whose assistant speaks English and Spanish, or as `frontdesk@dhanmondi-demo.test` at Dhanmondi Diagnostic Centre, a second clinic in Dhaka that speaks Bangla first ([experimental](docs/languages.md)) and sees none of Maple Street's data; the password is `attendra-demo-password`. Everything is synthetic and gone when you stop it. Demo mode skips two-step sign-in; a real deployment never does.

| The week's calls | One call: transcript and every tool step |
|---|---|
| ![The call list with outcomes, emergency flags and what the assistant did](docs/images/calls.png) | ![A booking call: the read-back, the clear yes and the confirmed change](docs/images/call-detail.png) |
| **Refills and callbacks for the front desk** | **Clinic settings, validated before they save** |
| ![The task queue with claim and done](docs/images/tasks.png) | ![Greeting, hours, providers and routing](docs/images/settings.png) |

With no key at all, **Test call > Play a simulated call** runs a scripted booking call through the real assistant and opens it live, so you can watch the captions and the tool steps, coach the assistant and end the call.

### Talk to it

Put an OpenAI key in `.env` at the repo root (`OPENAI_API_KEY=sk-...`) and run `pnpm demo` again. The dashboard's **Test call** page then talks to the demo clinic's receptionist through your microphone, about $0.05 a minute. No phone number needed: [docs/test-calls.md](docs/test-calls.md).

### Take a real call

[docs/live-call.md](docs/live-call.md) takes a small server to a real phone number the demo clinic answers, in about an hour. For your own clinic, follow [docs/self-hosting.md](docs/self-hosting.md).

## Repository layout

```
apps/voice/            the webhook and the per-call runner (Fastify)
apps/api/              the dashboard API: Better Auth, roles, calls, schedule, patients, requests, team, settings, audit (NestJS)
apps/web/              the staff dashboard (Next.js, Tailwind, TanStack Query), Playwright specs in e2e/
apps/worker/           background jobs on pg-boss: summaries, document indexing, webhook delivery, the retention purge
apps/mcp/              the MCP server, over stdio and Streamable HTTP, with per-clinic API keys
packages/core/         clinic config, hours, slots, routing, identity, emergency and confirmation rules, the ports
packages/agent/        CallState, the tools and their guards, the delegation loop, the Responses API planner
packages/voice-engine/ the VoiceEngine interface and the GPT-Live implementation; prompt; CallRunner
packages/scheduling/   the booking rules and the one write both the assistant and the front desk use; the built-in SchedulerAdapter (EHR adapters implement the same interface)
packages/telephony/    SIP header parsing, templated SMS through Twilio
packages/db/           SQL migrations with RLS, Drizzle schema, PHI encryption, repositories, synthetic seed
packages/knowledge/    the clinic's documents: extraction, chunking, embeddings, hybrid search, grounded answers
packages/webhooks/     Standard Webhooks signing, the SSRF guard, delivery
packages/observability the redacting logger
evals/                 call scenarios (YAML), the simulator that runs them, the judge, and simulated callers (evals/sim)
infra/                 Docker Compose and the images
docs/                  architecture, safety, HIPAA, self-hosting, roadmap, decision records
```

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: commits need a DCO sign-off, agent behaviour needs an eval scenario, and real patient data never goes anywhere in this repository, including issues.

Security reports go through [private vulnerability reporting](SECURITY.md), not public issues.

## License

[AGPL-3.0-only](LICENSE). You can run, modify and self-host Attendra freely. If you offer a modified version to others over a network, you must share your changes under the same license.

Built and maintained by [Elegant IT Limited](https://eleganttechbd.com).
