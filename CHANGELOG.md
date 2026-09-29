# Changelog

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/); until 1.0, minor versions may change behaviour.

## [Unreleased]

### Added

- Live calls: Today and Calls show a Live now strip with each call's length, who is calling once verified, and what the assistant is doing. Opening one shows live captions that follow the conversation (and pause while you scroll up), the tool steps as they run, the read-back waiting for a yes, and an emergency banner the moment the guardrail fires. When the call ends the page becomes the call record.
- Staff on a live call can send the assistant a short note, take the call to the front desk line or their own number, or end it. A note never overrides the rules in code. Each action is audited, sent once per click, and a second person is told who already has the call. A browser test call cannot be transferred. A new permission, `calls:coach`, is for owners, managers and front desk staff.
- An opt-in sound and notification when an emergency starts on any live call, kept per browser.
- Simulated calls in the local demo: a scripted booking call through the real assistant, with no audio and no OpenAI, from Test call. The e2e suite watches, coaches and ends one.
- A summary of every call, written by a new worker service (`apps/worker`, on pg-boss in the same Postgres). It holds two or three sentences for staff, what the caller wanted, how they came across, whether the call needs review and why, and a suggested follow-up. It is encrypted, written once per call, and audited. Without an OpenAI key it is written from the call's facts alone.
- The call page shows the summary with intent and sentiment badges and the review flag, and a flagged call can be marked reviewed. The call list has a Needs review filter, Today lists flagged calls, and requests the assistant created show the suggested next step.
- A retention period per clinic (`retentionDays`, 2555 days by default): a nightly job deletes older transcripts and summaries and audits how many.
- Background jobs retry with exponential backoff and then go to a dead-letter queue. The `worker_jobs` view shows each clinic its own jobs.
- The assistant can have a name ("Maya"), which it introduces itself with. A name never counts as the AI disclosure: the greeting must still say AI assistant, and a greeting that names the software is refused.
- Spanish, and Bangla as an experimental language. Each clinic chooses the languages its assistant speaks and a primary language; calls start in the primary one and follow the caller. Offered times, read-backs, text messages and the emergency script are in the caller's language, and visit types and providers can have a name in each. See [docs/languages.md](docs/languages.md).
- The emergency guardrail and the clear-yes check work in every language on every call. The emergency script gives the clinic's emergency number, which defaults from its country (911, 999), and names 988 only in the United States.
- A second demo clinic, Dhanmondi Diagnostic Centre in Dhaka, in Bangla first and English second, open Saturday to Thursday, with its own login (`frontdesk@dhanmondi-demo.test`) that sees only that clinic.
- Settings > Assistant and languages: the assistant's name, the languages with an Experimental badge on Bangla, the primary language, the emergency number, and a greeting preview in each language.
- 11 new evals: 5 in Spanish (a booking, a hedge, chest pain, a refill, three wrong dates of birth) and 6 in Bangla (a booking with "ji", the hedge "na, pore", report times, a price, an emergency with 999, and a caller mixing Bangla and English). Scenarios can name their clinic and check the call's language, what was said and which FAQ answered.
- Dates of birth can be said with Spanish or Bengali month names and Bengali digits, and a numeric date is read day first outside North America.
- A design system for the dashboard: semantic colour tokens for light and dark, Inter and Noto Sans Bengali self-hosted, one type scale, three radii, two shadows and one focus ring, and a component kit (buttons, fields, switches, tabs, panels, menus, tooltips, toasts, stat cards with sparklines and more). See [docs/design.md](docs/design.md).
- Dark mode, chosen per person (system, light or dark) and applied before the first paint.
- A command palette (Cmd+K or Ctrl+K) to jump to a page, find a patient, start a booking or a test call, or switch the theme, and keyboard shortcuts (G then T, S, P, R or C; N; ?).
- Request actions update at once and roll back if the server refuses, with a toast, and Undo after a claim. Today opens with four stat cards and seven-day trends; `/overview` returns per-day counts for them.
- The sidebar collapses to icons from 1024 px, and a phone gets a bottom bar. Every main page is checked with axe in light and dark in the e2e suite.
- Test calls from the browser: a Test call page in the dashboard talks to the clinic's receptionist through the microphone over WebRTC, with the live settings and the same tools and guardrails as a phone call. Only an OpenAI key is needed; `pnpm demo` turns it on when it finds one. See [docs/test-calls.md](docs/test-calls.md).
- Calls record where they came from (`phone` or `web`). Browser tests are marked in the call list and on the call page, and each one is audited with the person who started it, in the same transaction as the call row.
- Test calls end on their own after `BROWSER_CALL_MAX_SECONDS` (300 by default), a clinic can have two open at once, and they never send texts.
- The Schedule: every booking in a day or week view with a column per provider, opening hours shaded, holidays marked, cancelled visits struck through, and who booked each one (the assistant or a named staff member). The front desk books, moves and cancels from a side panel and a four-step New booking flow that offers only real open times.
- Staff bookings follow the assistant's rules exactly: the same slot search decides what is bookable, the same write stops double booking, and every change is audited and idempotent. Cancellations record a reason from a fixed list.
- The call page shows what the call booked or cancelled ("Booked: Tue 6 Oct 3:00 PM with Dr. Okafor") with a link to it on the schedule.
- Patients: search by name, date of birth or full phone number (as a POST, so what is typed never reaches a URL or a log), a list of the patients you opened recently, and Add patient. A patient's page shows their age, date of birth, phone and usual provider, with tabs for appointments (book, move and cancel from there), the calls they were verified on, their requests, and their details to edit. See [decision 7](docs/decisions/0007-patient-search.md).
- Patients added or edited at the desk get the same lookup and phone hashes the voice path uses, so the assistant can verify them on their next call. Someone with the same name and date of birth as a patient on file is refused, with a link to the existing record.
- Calls are linked to the patient the assistant verified (`calls.patient_id`), never from the calling number alone. The call page shows who was calling with a link to their record, and New booking can find a patient or add one without leaving the flow.
- Today, the new home screen: what needs someone (emergencies from the last day, requests nobody has claimed with how long they have waited, calls that went to a person or ended with nothing done), each with one action; today's appointments for each provider with the next one marked and the open gaps shown; what the assistant did today and over 7 days, down to talk minutes and an estimated cost; and the latest calls. It refreshes every 30 seconds.
- `GET /overview` counts calls, bookings, changes, requests, handovers, after-hours calls and talk time in the database, with no patient data, so a viewer sees it too. `GET /tasks/waiting` lists unclaimed requests by type and age only.
- Requests (what the dashboard called Tasks): each type explained in a line at the top, filters by type, status, assigned to me and unassigned, the patient and the call each one came from, how long it has waited and who has it. Staff add internal notes, which are encrypted and never edited, and close a request with an outcome ("Called back", "No answer, left a message", "Refill sent to the pharmacy", "Not needed"). Owners and managers can assign one to a teammate.
- Calls: filters by date range, outcome, channel and emergency, a search by patient name (a POST, matched through the verified patient), and a Caller column with the verified patient's name, or "Unknown caller".
- Team: owners and managers list the people who can sign in, with their role and whether they have set up their password and two-step sign-in; add someone and see a temporary password once, to pass on in person; reset a password; change a role; and remove someone. A manager cannot touch an owner or make one, nobody changes, resets or removes themselves, and there is always an owner. Each change and its audit rows are one transaction with the team locked, so this holds under races too.
- A temporary password is for one sign-in and 72 hours. The person chooses their own password before anything else, two-step setup included, so whoever read the temporary one out never holds a working password for them; every other session ends when they do. `pnpm add-member` passwords are temporary too. An email that already has an Attendra account with another practice is refused (`account_exists`) rather than added.
- The front desk cannot book a patient into a time that overlaps another of their appointments, with any provider, and a booking key sent again for a different booking is refused (`idempotency_mismatch`).
- The menu is grouped the way a front desk works: Today; Front desk (Schedule, Patients, Requests, Calls); Assistant (Test call, Settings); Admin (Team, Audit log). The audit log has plain words for every action and names people for owners and managers.
- `pnpm demo` fills three weeks of the demo calendar around today: the demo calls' own bookings, linked to their calls, and about 60 percent of the rest booked by staff, with a few cancellations.

### Changed

- Migration `0010_staff_transfer_number.sql` adds an optional `transfer_number` to memberships, for taking over a live call on your own phone.
- `GET /me` says whether simulated calls are available (`simulatedCalls`), and `testCalls` is now true only when the voice service takes real browser calls.
- Migration `0009_call_summaries.sql` adds `call_summaries` (encrypted text, with Row Level Security), `audit_logs.counts` for audit rows that record how much was done, and `sms_messages.provider_sid`.
- The planner's model calls now have a 15 second timeout and a cap of 1,000 output tokens per round.
- `ClinicConfig` gains `assistantName`, `languages` (default `["en"]`), `primaryLanguage` (default `"en"`), `emergencyNumber` and, on visit types and providers, `names`. Existing configurations keep working unchanged. The greeting's disclosure check now accepts any of the clinic's languages.
- The demo clinic's assistant is called Maya and speaks English and Spanish.
- Signing in now opens Today instead of the call list.
- "Tasks" are "Requests" everywhere in the dashboard, and `/tasks` pages move to `/requests`. The API keeps the name `tasks`.
- Migration `0006_request_notes.sql` adds `task_notes` (encrypted, insert-only for the application role, with Row Level Security) and a request's outcome and who assigned it.
- The call list names the verified caller for roles that may read calls, and audits that view once per 5 minutes; a viewer's call list still has no patient data.
- `POST /tasks/:id/done` takes an optional `outcome`.
- Migration `0007_password_change.sql` adds `must_change_password` and `temporary_password_expires_at` to `auth_users`. `POST /api/auth/change-password` joins the auth allowlist; the API answers 403 `password_change_required` until it has been used.
- Migration `0008_same_clinic_links.sql`: composite foreign keys keep `calls.patient_id` and `task_notes.task_id` inside one clinic, since Row Level Security does not cover foreign key checks.
- A repeat view is only folded into an earlier audit row when every parameter of the view and every patient it showed are the same. Searches write one `patient.search.result` row per patient shown.
- Removing someone from the team releases the requests they held, and signs them out only when they belong to no other practice. The Team page no longer shows a last sign-in time, which could not be told apart by practice.
- Moving and cancelling at the desk only change a booking that is still booked, so a cancel that landed a moment earlier is reported instead of undone. Dates of birth are checked against the clinic's date.

### Fixed

- The demo moved its own bookings forward in milliseconds, so after a clock change a visit shifted by an hour. It now moves them by whole weeks of local time.
- The week view's provider headers showed initials; they show the short name, with the full name on hover.
- Migration `0005_call_patient.sql` adds `calls.patient_id`, set in the same transaction as the tool action that verified the caller.
- The redacting logger also replaces `query` and `search` fields.
- Migration `0004_staff_scheduling.sql`: appointments record the staff member who booked or cancelled them, a cancel reason, an encrypted note and an update time, and a booking must come from a call or a person.
- A screen that refreshes a patient-data view on a timer (the schedule) writes one audit row per person per view every 5 minutes, instead of one every 30 seconds.
- The voice service starts without Twilio or a webhook secret. Without Twilio, texts are recorded as not sent; without the secret, phone calls are refused.
- An empty line in `.env` counts as not set for the voice service's settings and for `VOICE_URL` and `VOICE_INTERNAL_TOKEN`.
- `/api/v1/me` says whether the deployment has test calls (`testCalls`).
- The dashboard allows its own pages to use the microphone (`Permissions-Policy: microphone=(self)`); camera and location stay off.

### Fixed

Found on the first live test call:

- A clear "yeah" to a read-back was refused when the assistant began speaking before the proposal was back and read it out in the same breath. Any assistant speech after the proposal now counts as the read-back.
- A cough or breath the transcriber marks in brackets ("[clear throat]") after the caller's yes made the yes not count. Bracketed sounds are now ignored.
- The assistant could not answer "are you open tomorrow?": clinic info now carries the next seven days of hours.
- The planner did not know today's date, so "next week" became today. Its prompt now states the date, and `find_slots` says how to set `from_date`.

## [0.2.0] - 2026-09-29

The front desk: a staff dashboard, its API, and demo mode.

### Added

- The staff dashboard (`apps/web`) and its API (`apps/api`): the call list with outcomes and flags, each call's transcript and tool steps, the refill and callback queue with claim and done, clinic settings, and the audit log.
- Sign-in with Better Auth: organizations, four roles (owner, admin, staff, viewer), TOTP two-factor required before any clinic data, 12-hour sessions, no public sign-up. People are added with `pnpm add-member`.
- Every transcript and task view is audited in the same transaction as the read. A clinic you do not belong to answers 404.
- The task queue: claim, release (owners and admins can release anyone's), done. The menu badge uses a count that reads no patient data.
- The dashboard signs out after 15 idle minutes and clears its cache on sign-out. API responses are never cached.
- Demo mode: `pnpm demo` starts the API on an in-memory Postgres with a week of calls played through the real agent, plus the dashboard. Docker Compose does the same with `ATTENDRA_DEMO_MODE=true`, with the demo password taken from `ATTENDRA_DEMO_PASSWORD` and transfer numbers locked.
- `pnpm db:add-number` points a phone number at a clinic. [docs/live-call.md](docs/live-call.md) walks a small server to a real test call.
- Call scenarios carry the assistant's spoken reply, checked against `forbid_spoken` like everything else it says.
- End-to-end dashboard tests (Playwright) in CI.

### Fixed

- Read-backs said "a annual physical"; they now use "an" before a vowel.
- `pnpm db:seed` could create a second copy of each demo patient when run twice, and reset the clinic's settings on every start.
- CI's sign-off check read the merge commit GitHub builds for a pull request, which is never signed, so it failed on every pull request.

## [0.1.1] - 2026-09-28

Security and CI fixes after the first release.

### Security

- The OpenAI webhook has a per-address rate limit (600 a minute by default) and answers 429 above it. The health check is not limited.
- drizzle-orm moves to 0.45.3 for CVE-2026-39356 (SQL identifiers were not escaped). Attendra builds identifiers only from its own schema, never from caller input, so it was not exploitable here.

### Changed

- Migration `0010_staff_transfer_number.sql` adds an optional `transfer_number` to memberships, for taking over a live call on your own phone.
- `GET /me` says whether simulated calls are available (`simulatedCalls`), and `testCalls` is now true only when the voice service takes real browser calls.
- Migration `0009_call_summaries.sql` adds `call_summaries` (encrypted text, with Row Level Security), `audit_logs.counts` for audit rows that record how much was done, and `sms_messages.provider_sid`.
- The planner's model calls now have a 15 second timeout and a cap of 1,000 output tokens per round.
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
