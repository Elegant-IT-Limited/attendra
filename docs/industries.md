# Industries

Attendra's engine does not know what trade it works in. Booking, the identity check, the emergency guardrail, requests, the clinic's knowledge, live calls and the audit log are the same everywhere. An **industry pack** adds what depends on the trade: what things are called, and the lines of the conversation prompt that only make sense there.

Each account picks one in its settings (`industry`, default `clinic`). Two account settings matter most to the veterinary pack: `emergencyHospital` (where an animal in danger is sent) and `afterHours` (`book` as usual, or `requests`: out of hours nothing is booked and the caller's visit becomes a request for the team). Packs live in `packages/core/src/industries/`, one file each, as data:

- `terms`: what the business, the people who are booked for, and the people who can be booked are called. The dashboard menu and page titles use them, and so does the conversation prompt. They are English, like the dashboard and the prompt; callers still hear their own language.
- `prompt.identify`: how to find out who a booking is for, and what to ask to look them up or add them.
- `prompt.preferences`: preferences a caller may have about who they see.
- `prompt.limits`: what the assistant must never do in this trade.
- `identity`: how a caller's record is found. `person`: full name, date of birth and phone. `pet`: the owner's full name, the pet's name and the phone; the record is the pet's, with the owner as its guardian, and the kind of animal is stored with it.
- `planner`: the backend planner's rules, limits and tool descriptions for the trade, and `toolArgs` where a tool takes different arguments (a pet's tools take `owner_name` and `pet_name`).
- `emergency`: the trade's own emergencies, per language, and the script that answers them (see [safety](safety.md)). The engine's list for the person on the phone always applies too.

Database tables and API fields keep their names (`patients`, `providers`, `visit_types`) whatever the pack calls them, so a pack never needs a migration.

## Adding a pack

1. Add the id to `INDUSTRIES` in `types.ts` and a file next to `clinic.ts`.
2. Register it in `INDUSTRY_PACKS` in `index.ts`.
3. Add call scenarios under `evals/scenarios/` that use it. A pack without scenarios is not merged.

The rules that keep callers safe stay in the engine and apply to every pack: nothing is booked without a read-back and a clear yes, records are never confirmed to an unverified caller, and the emergency guardrail cannot be turned off.

## Packs

| Id | For | Since |
|---|---|---|
| `clinic` | Medical practices | 0.1 (as a pack since 0.6) |
| `vet` | Veterinary clinics | 0.7 |
