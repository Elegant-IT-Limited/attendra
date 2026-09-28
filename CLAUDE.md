# CLAUDE.md

Guidance for AI coding assistants (and humans) working in this repository. Read [docs/architecture.md](docs/architecture.md) and [docs/safety.md](docs/safety.md) first.

## Project in one line

Attendra: an open-source (AGPL-3.0) AI phone receptionist for medical practices. Twilio SIP to OpenAI GPT-Live for voice; our TypeScript backend for identity checks, scheduling, tasks and audit.

## How to work

- Before a change that touches more than one package, write a short plan (files, interfaces, tests) and get it agreed.
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
pnpm db:migrate && pnpm db:seed    # against DATABASE_URL; synthetic data only
docker compose -f infra/docker-compose.yml up
```

Keep these working. If you add a command, add it here and in the README.

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
