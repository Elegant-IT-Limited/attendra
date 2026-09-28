# Changelog

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/); until 1.0, minor versions may change behaviour.

## [Unreleased]

### Security

- The OpenAI webhook has a per-address rate limit (600 a minute by default) and answers 429 above it. The health check is not limited.
- drizzle-orm moves to 0.45.3 for CVE-2026-39356 (SQL identifiers were not escaped). Attendra builds identifiers only from its own schema, never from caller input, so it was not exploitable here.

### Changed

- CI runs the gitleaks CLI, pinned and checksum-verified, and the current major versions of the GitHub actions.

## [0.1.0] - 2026-09-28

First public version.

### Added

- Inbound calls over Twilio Elastic SIP Trunking to OpenAI GPT-Live, with webhook signature verification, delivery de-duplication, and SIP 404 for numbers no clinic owns.
- Client delegation: a backend planner (Responses API, `store: false`) that works only through guarded tools.
- Identity check by full name and date of birth, three attempts, identical answers for "not found" and "wrong date".
- Built-in scheduler with provider hours, visit lengths, lead time, holidays, idempotent booking and a database-level guarantee against double booking.
- Two-step writes: propose, read back, commit only on a clear yes in the caller's own words.
- Emergency guardrail on every caller transcript fragment, with 911 and 988 scripts and an optional delayed transfer to the on-call line.
- Refill and callback requests as staff tasks.
- Templated SMS confirmations, sent at most once per booking.
- Postgres schema with Row Level Security on every clinic table, AES-256-GCM encryption for PHI columns, keyed-hash lookups, an append-only audit log.
- A logger that redacts PHI by field name and by pattern.
- 15 call scenarios run by an in-process simulator on every pull request.

### Security and safety hardening before release

- The emergency guardrail keeps listening after its first match, refuses writes for the rest of the call and drops in-flight requests; the bare word "emergency" no longer rings the on-call line.
- A yes counts only if spoken after the read-back began; a pending change with no read-back cannot be committed.
- Outdated requests cannot write. Transfers and hang-ups wait for the spoken result.
- PHI ciphertext is bound to its clinic, table and column; lookup hashes are per clinic.
- Confirmations go to the phone number on the patient's record, retry after a failed send, and are audited.
- Call setup failures reject with SIP 503 or hang up, never leave the caller in silence; one call is accepted once even when it arrives as both webhook types.
