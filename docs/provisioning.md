# Provisioning

A hosting layer (sign-up, billing, phone numbers) opens and runs accounts through `/api/v1/provisioning`, with a bearer token both services share. Self-hosters do not need it: `pnpm add-member`, `pnpm db:add-number` and `pnpm db:test-call-limit` do the same by hand.

```bash
# the API's .env
ATTENDRA_PROVISIONING_TOKEN=...   # 32 characters or more: openssl rand -base64 32
ATTENDRA_PROVISIONING_SIGNATURES=accept   # or require: signed requests only (below)
```

Without the token the routes answer 404. With it, every request needs `Authorization: Bearer <token>`, or a signature made with it (below). Call them from the server only, never from a browser. None of them reads patient data.

### Signed requests

A request can prove it holds the token without sending it: it carries the time it was made and an HMAC-SHA256, keyed with the token, of that time, the method, the path with its query, and a SHA-256 of the body (`apps/api/src/http/signature.ts`):

```
attendra-timestamp: 1794052800
attendra-signature: v1=<hex of HMAC-SHA256(token, "<timestamp>\n<METHOD>\n<path?query>\n<sha256 hex of the raw body, or of the empty string>")>
```

A signature is good for 5 minutes either way of the engine's clock, and for that request only: another path, method or body fails it. A signature that is there must be good, whatever else the request carries (`401 bad_signature`, or `signature_expired` when it is old). `ATTENDRA_PROVISIONING_SIGNATURES=require` makes it the only way in: the bearer token alone answers `401 signature_required`. Move a hosting layer over in two steps: sign every request while still sending the bearer token, then require signatures and stop sending it. The engine signs what it posts to the hosting layer's mail hook the same way.

### Sending a POST again

Every POST takes an `Idempotency-Key` header (8 to 128 letters, digits or `-_:.`; a UUID fits). A POST sent again with the same key, after a timeout or a lost answer, is answered with the first answer and `Idempotent-Replayed: true`, and nothing is done twice. The same key with another body answers `422 idempotency_key_reused`; while the first request is still being answered, `409 idempotency_in_progress`. A request that failed frees its key. Answers are kept 24 hours, encrypted. The same works on the dashboard's API, where a key belongs to the person who sent it; the dashboard sends one with every POST.

| Route | What it does |
|---|---|
| `POST /provisioning/accounts` | A new organization, its clinic and its owner. Body: `organization.name`; `clinic.name`, `clinic.timezone` (IANA), `clinic.industry` (`vet` or `clinic`), `clinic.phone` (the clinic's own main number, E.164, which sets the country; it is not pointed at Attendra); `owner.name`, `owner.email`, `owner.password` (12 characters or more); optional `testCallMinutes`, `plan` and `replaceUnconfirmed`. Answers `201 { organizationId, clinicId, userId }`, or `409 { error: 'email_taken', confirmed }`. With `replaceUnconfirmed: true`, an account with this email that was never confirmed, is older than 48 hours (the confirmation link's lifetime) and has had no calls is removed, with what it opened alone, and this one is opened instead. A younger one is kept, so its link can never confirm someone else's sign-up: the hosting layer sends that link again instead. The clinic starts from its pack's first settings: weekday hours, the pack's visit types, one provider to book with, no FAQ. |
| `POST /provisioning/organizations/:organizationId/clinics` | Another location in the organization. Body: `clinic` as above, optional `testCallMinutes`. Answers `201 { clinicId }`, or 404 for no such organization. It starts from the pack's first settings and copies the first clinic's assistant: texting, languages, assistant name, voice, how it talks, call-record days, common questions, kinds of request, fields and menu links; hours, doctors, address, transfers and hospitals are its own. Everyone in the organization sees it (memberships are per organization). Audited on the first clinic as `clinic.created`. |
| `POST /provisioning/email-confirmations` | `{ email }`. An account opened here cannot sign in until its address is confirmed; the hosting layer sends the link and calls this when it is opened. |
| `DELETE /provisioning/accounts/unconfirmed` | `{ email }`. Takes back an account whose email was never confirmed, with what it opened alone: for a sign-up the hosting layer could not finish. `204`, `404 not_found`, or `409` when it is confirmed (`confirmed`) or has had calls (`in_use`). |
| `POST /provisioning/users/reset-two-factor` | `{ email }`. Support, for someone who lost their phone and has nobody at the clinic to reset two-step sign-in for them. Turns it off and signs them out everywhere; they set it up again at their next sign-in. `204` or `404`. |
| `PUT /provisioning/clinics/:clinicId/voice-engine` | `{ engine }`: `gpt-live`, `gpt-realtime`, or `null` for the deployment's default. Which engine answers the clinic's calls (see docs/live-call.md, Two engines). Settings cannot change it. |
| `PUT /provisioning/clinics/:clinicId/voice-flow` | `{ flow }`: `tools`, `planner`, or `null` for the planner. With `tools` the voice calls the tools API itself (gpt-realtime: function tools on the voice model; GPT-Live: Responses delegation with the same tools); with `planner` every turn is handed to the planner, as before. See docs/tools-api.md. Settings cannot change it. |
| `PUT /provisioning/clinics/:clinicId/realtime-model` | `{ model }`: `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, or `null` for the deployment's (`ATTENDRA_REALTIME_MODEL`). Which gpt-realtime model answers the clinic's calls when it is on gpt-realtime, for a one-clinic trial of the cheaper model; each call's tokens are priced as the model it ran on. Settings cannot change it. |
| `PUT /provisioning/clinics/:clinicId/test-call-limit` | `{ seconds }`, or `null` for no limit. |
| `POST /provisioning/clinics/:clinicId/test-call-top-up` | `{ remainingSeconds, dryRun? }`: at least this much test-call time left (the limit becomes the time used plus it, never lower). Returns `{ limitSeconds, usedSeconds, newLimitSeconds, changed }`; a clinic with no limit keeps none. |
| `PUT /provisioning/clinics/:clinicId/numbers/:number` | Points a number (E.164, URL-encoded) at the clinic: calls to it reach the assistant and texts are sent from it. |
| `DELETE /provisioning/numbers/:number` | Stops a number reaching any clinic. |
| `GET /provisioning/clinics/:clinicId/purge-preview?force=&keepLogins=` | What the delete below would remove, with the same options, and changes nothing: `{ counts, blockers }`. `counts` is rows per table (`calls`, `patients`, `auth_users`, `pgboss.job`, ...); `blockers` lists what would refuse it. 404 for no such clinic. |
| `DELETE /provisioning/clinics/:clinicId?force=&keepLogins=` | Deletes the clinic with everything recorded for it, its organization when it was the last clinic, and the logins left with no team. Answers `200 { deleted }`, the rows deleted per table. Without `force=1` only a clinic closed 30 days ago or more (`409 not_closed`, `409 closed_recently`); with it, any clinic, such as a tester's. `keepLogins=1` keeps every login and takes away only its memberships of what went. Always `409 call_in_progress` while a call that started in the last 6 hours has not ended, and `409 number_assigned` while a number still reaches the clinic: release the numbers first. Each 409 also lists every `blockers`. The clinic's audit log goes with it, so the hosting layer keeps its own record of who asked. |
| `GET /provisioning/clinics/:clinicId/usage?from=&to=` | Phone calls in the period (ISO times): `{ calls, seconds }`, each call start to end, rounded up to the second. Browser test calls are not counted. |
| `POST /provisioning/clinics/:clinicId/calls-check` | `{ since, from? }`: phone calls that started since `since` (ISO time), ended or not: `{ calls, lastCallAt, heard, openMinutes }`. With `from` (E.164), `heard` says whether one came from that number, compared by its keyed hash (the forwarding check: the owner calls the clinic's own number from a phone); otherwise `null`. `openMinutes` is how long the clinic was open since then, by its hours, holidays and special days, for at most 7 days (a quiet line). A POST, so a number is never in an address. |
| `GET /provisioning/clinics/:clinicId/report?weeks=1` | The weekly report: the clinic's name, time zone, industry and average visit value, its owners with a confirmed address, and the Quality page's numbers for the last whole weeks, newest first. |

## Password reset emails

The engine has no mailer. With a hook, "Forgot your password?" appears on the sign-in page and the engine asks the hosting layer to send the link:

```bash
ATTENDRA_MAIL_HOOK_URL=https://accounts.internal/api/engine-mail   # called with the provisioning token
```

It posts `{ type: 'password_reset', email, name, emailVerified, url }` with `Authorization: Bearer <provisioning token>`. The link works once, for one hour, and signs the person out everywhere when used. The sign-in page answers the same, as fast, whether or not the address has an account (the request is not waited for). Requests are limited to 5 an hour from one network address; the hosting layer should also limit emails per recipient. Without the hook, the page tells people to ask their practice owner or manager, who reset passwords on the Team page.

## Team invitations

With the same hook, Team > Add people emails an invitation to every address, and nobody is shown a temporary password: the answer is "invite sent" whatever the address, so a clinic never learns who already uses Attendra. The engine posts:

```json
{ "type": "team_invitation", "email": "sam@example.com", "name": "Sam Lee", "clinicName": "Maple Street", "role": "Front desk",
  "expiresAt": "2026-11-13T15:00:00.000Z", "url": "https://dashboard.example/", "setPasswordUrl": "https://dashboard.example/reset-password?token=…" }
```

`url` opens the dashboard, where the person accepts or declines from a banner. `setPasswordUrl` is there only for an account with no password yet (one the invitation made): it works once, until the invitation lapses after 7 days. Without the hook, someone who already has a login is invited from the banner alone, and a new address gets an account and a temporary password, shown once, as before.

## Two-step sign-in

The dashboard requires two-step sign-in by default. A hosted service whose accounts hold no patient health information, such as veterinary clinics, can make it optional:

```bash
ATTENDRA_TWO_FACTOR=optional
```

People can still turn it on for themselves. Keep it required wherever the dashboard holds patient records.

Between the two, `managers` requires it of owners and practice managers, the roles that manage the team, API keys and webhooks, and leaves it a choice for front desk and viewers:

```bash
ATTENDRA_TWO_FACTOR=managers
```

A person who is an owner or practice manager at any of their locations must have it on. Someone made a practice manager is sent to set it up at their next click, before they can manage anything; until then they see only who they are. Turning it off is offered only to people who don't need it.

## Signing out when idle

The dashboard signs out after 15 minutes without activity in any of its tabs. A hosted service whose accounts hold no patient health information can choose longer, from 5 minutes to 12 hours (either way, a session ends 12 hours after it was last used; ten minutes before the dashboard signs out it says when, and the sign-in page says why it did):

```bash
ATTENDRA_IDLE_MINUTES=120
```
