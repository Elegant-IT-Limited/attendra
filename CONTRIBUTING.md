# Contributing to Attendra

Thank you for helping. Attendra answers calls from patients, so the bar is a little higher than usual: every change is tested, safety changes get a second reviewer, and real patient data never enters this repository.

## Ground rules

- **No real PHI, anywhere.** Not in code, fixtures, tests, seeds, screenshots, logs you paste, commit messages or issues. Use the synthetic demo patients in `packages/db/src/seed.ts`, or Synthea output.
- **Rules live in code.** If the agent must or must not do something, enforce it in `packages/agent/src/tools.ts` or `packages/core`, and add a scenario in `evals/scenarios/` that tries to make it misbehave.
- **No medical advice features.** Triage, diagnosis, symptom interpretation and prescription decisions are out of scope and will not be merged.

## Setup

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm eval
```

The test suite runs Postgres in-process (PGlite), so there is nothing else to install.

## Making a change

1. For anything bigger than a fix, open an issue first so we can agree on the shape.
2. Branch from `main`; keep one change per pull request.
3. Add tests. New PHI fields need an encryption path and a line in the redaction test. New tables need a Row Level Security policy and a cross-tenant test.
4. Start new source files with `// SPDX-License-Identifier: AGPL-3.0-only`.
5. Write commits as `type: summary` (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), with a body that says why.
6. Sign off every commit: `git commit -s`. CI checks it.

## Developer Certificate of Origin

By signing off (`Signed-off-by: Your Name <you@example.com>`), you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the change or otherwise have the right to submit it under this project's license. Attendra does not use a CLA; see [docs/decisions/0004-license-and-dco.md](docs/decisions/0004-license-and-dco.md).

## Review

Changes to `packages/core/src/emergency.ts`, `packages/agent/src/tools.ts`, the redacting logger or the migrations need approval from a maintainer (see `.github/CODEOWNERS`). Changes to the emergency phrase list also need a clinician's review before release, recorded in the pull request.
