# Development

How Attendra is built and what every change must keep true. Read [architecture.md](architecture.md) and [safety.md](safety.md) first; [CONTRIBUTING.md](../CONTRIBUTING.md) covers how to send a change.

Attendra is an open-source (AGPL-3.0) AI phone receptionist for medical practices: Twilio SIP to OpenAI GPT-Live for voice, and a TypeScript backend for identity checks, scheduling, requests and audit.

## How to work

- Before a change that touches more than one package, open an issue with a short plan (files, interfaces, tests) and agree it first.
- Prefer small, reviewable changes that follow the existing patterns. No drive-by refactors.
- Ask before adding a dependency; say what it is for and what the alternative is.
- Check the current OpenAI and Twilio docs before touching integration code. The Live API types come from the `openai` SDK; prefer them over hand-written shapes.
- Clinical, legal and compliance questions go to the maintainers. Do not decide them in code.

## Commands

```
pnpm install
pnpm test                 # vitest: unit, Postgres (PGlite) integration, eval scenarios
pnpm eval                 # scenario report; --live uses the real planner model
pnpm lint && pnpm typecheck
pnpm db:migrate && pnpm db:seed    # against DATABASE_URL; the seed also needs ATTENDRA_DATA_KEY; synthetic data only
pnpm db:rehash-lookups    # once after upgrading to v0.4.1, with DATABASE_URL and ATTENDRA_DATA_KEY
pnpm demo                 # API on an in-memory Postgres with demo calls, plus the dashboard on :3000
pnpm test:e2e             # Playwright against the demo (starts both servers)
pnpm sim                  # simulated callers against the real planner (needs OPENAI_API_KEY, costs credit)
pnpm add-member --email <e> --name <n> --org <org> --role owner|admin|staff|viewer   # password in ATTENDRA_NEW_PASSWORD
pnpm db:add-number --clinic <clinic id> --number <E.164>
docker compose -f infra/docker-compose.yml up            # add --profile voice for the voice service, --profile mcp for MCP
```

The demo alone reads `ATTENDRA_TEST_CALLS`, `ATTENDRA_SIMULATED_CALLS`, `VOICE_PORT` and `ATTENDRA_WEBHOOKS_ALLOW_LOCAL` from the shell; `.env.example` says what each does.

There is no root `pnpm dev`: turbo's strict environment mode hands the services none of your variables and nothing loads a `.env`. Use `pnpm demo`, or a service's own `dev` script (`pnpm --filter @attendra/api dev`) with its environment set in the shell.

Keep these working. If you add a command, add it here and in the README.

## Layout

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
packages/observability/ the redacting logger
evals/                 call scenarios (YAML), the simulator that runs them, the judge, and simulated callers (evals/sim)
infra/                 Docker Compose and the images
docs/                  architecture, safety, HIPAA, self-hosting, roadmap, decision records
```

## Non-negotiable rules

### PHI

1. No real patient data anywhere in the repository: code, fixtures, tests, seeds, docs, screenshots, commit messages.
2. Log only through `@attendra/observability`. No `console.log` of request bodies, transcripts, names, dates of birth or phone numbers (ESLint enforces `no-console`).
3. PHI columns are encrypted through `createPhiCipher`. Never add a plaintext PHI column. A new PHI field needs a redaction test.
4. The voice model gets clinic facts and short verified results, never full records.

### Agent behaviour (in `runTool`, not in prompts)

1. Identity (full name and date of birth) before any patient-specific read or write.
2. Writes are propose then commit; commit needs a clear yes in the caller's own words since the read-back.
3. Every write carries an idempotency key.
4. Discard results from outdated task revisions.
5. Never report success before the tool confirms it.
6. No medical advice, triage, diagnosis or refill approval.
7. The emergency guardrail runs on every caller fragment and cannot be disabled.
8. Each append stays under 500 tokens (`clamp`). `thinking` for quiet progress, `commentary` for spoken results, `instructions` with a null delegation id for redirects.

### Voice and telephony

- Engine-specific code lives behind `VoiceEngine` in `packages/voice-engine`. GPT-Live with client delegation is the default; the `gpt-realtime` engine is planned and must implement the same interface.
- Verify every webhook signature; de-duplicate by delivery id; treat SIP headers as untrusted.
- One owner per side effect (the `CallRunner` for its session). Keep the sideband open until `session.closed`.

### Tenancy

- Queries filter on `clinic_id` and run inside `withClinic`; RLS is the second wall. A new table needs a policy and a cross-tenant test.
- Every PHI read and every write goes to `audit_logs`.
- Dashboard routes declare their permission with `@Requires(...)` (table in `apps/api/src/access.ts`) and need a `:clinicId`. A new route needs a cross-clinic 404 test and a role test in `apps/api/test`.
- Secrets come from the environment. Update `.env.example` when you add one.

## Conventions

- Zod schemas in `packages/core` for every external payload and tool argument.
- Business rules are pure functions in `packages/core` with unit tests.
- Adapters implement the ports in `packages/core/src/ports.ts`; no vendor SDK calls outside their package.
- New source files start with `// SPDX-License-Identifier: AGPL-3.0-only`.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) with a DCO sign-off (`git commit -s`).

## Definition of done

1. `pnpm lint && pnpm typecheck && pnpm test` pass.
2. New behaviour has unit tests; new agent behaviour has an eval scenario.
3. No PHI in logs (the redaction tests pass).
4. Docs updated.
5. A short summary of what changed, what was not done, and what needs a decision.
