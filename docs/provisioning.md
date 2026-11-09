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
| `PUT /provisioning/clinics/:clinicId/voice-engine` | `{ engine }`: `gpt-live`, `gpt-realtime`, `vapi`, or `null` for the deployment's default. Which engine answers the clinic's calls (see docs/live-call.md, Two engines; Vapi below). Answers `200 { previous }`, the engine it replaced (`null`: the deployment's default), so switching back restores exactly what the clinic had (before batch 6 it answered `204` with no body). `vapi` needs the location's Vapi assistant and number first (`409 vapi_not_provisioned`). Settings cannot change it. Audited (`clinic.voice_engine.<engine>`). |
| `PUT /provisioning/clinics/:clinicId/voice-flow` | `{ flow }`: `tools`, `planner`, or `null` for the planner. With `tools` the voice calls the tools API itself (gpt-realtime: function tools on the voice model; GPT-Live: Responses delegation with the same tools); with `planner` every turn is handed to the planner, as before. See docs/tools-api.md. Settings cannot change it. |
| `PUT /provisioning/clinics/:clinicId/realtime-model` | `{ model }`: `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, or `null` for the deployment's (`ATTENDRA_REALTIME_MODEL`). Which gpt-realtime model answers the clinic's calls when it is on gpt-realtime, for a one-clinic trial of the cheaper model; each call's tokens are priced as the model it ran on. Settings cannot change it. |
| `PUT /provisioning/clinics/:clinicId/voice` | `{ voice }`: one of the voices the gpt-realtime models speak (`alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `marin`, `sage`, `shimmer`, `verse`; core `REALTIME_VOICES`), or `null` for the default (`marin`). The same field as Settings > Greeting and voice: for trying a few voices by ear on test calls; the clinic sees the choice and can change it. Audited (`clinic.voice.<name>`). |
| `PUT /provisioning/clinics/:clinicId/test-call-limit` | `{ seconds }`, or `null` for no limit. |
| `POST /provisioning/clinics/:clinicId/test-call-top-up` | `{ remainingSeconds, dryRun? }`: at least this much test-call time left (the limit becomes the time used plus it, never lower). Returns `{ limitSeconds, usedSeconds, newLimitSeconds, changed }`; a clinic with no limit keeps none. |
| `PUT /provisioning/clinics/:clinicId/numbers/:number` | Points a number (E.164, URL-encoded) at the clinic: calls to it reach the assistant and texts are sent from it. |
| `DELETE /provisioning/numbers/:number` | Stops a number reaching any clinic. |
| `GET /provisioning/clinics/:clinicId/purge-preview?force=&keepLogins=` | What the delete below would remove, with the same options, and changes nothing: `{ counts, blockers }`. `counts` is rows per table (`calls`, `patients`, `auth_users`, `pgboss.job`, ...); `blockers` lists what would refuse it. 404 for no such clinic. |
| `DELETE /provisioning/clinics/:clinicId?force=&keepLogins=` | Deletes the clinic with everything recorded for it, its organization when it was the last clinic, and the logins left with no team. Answers `200 { deleted }`, the rows deleted per table. Without `force=1` only a clinic closed 30 days ago or more (`409 not_closed`, `409 closed_recently`); with it, any clinic, such as a tester's. `keepLogins=1` keeps every login and takes away only its memberships of what went. Always `409 call_in_progress` while a call that started in the last 6 hours has not ended, and `409 number_assigned` while a number still reaches the clinic: release the numbers first. Each 409 also lists every `blockers`. The clinic's audit log goes with it, so the hosting layer keeps its own record of who asked. |
| `GET /provisioning/clinics/:clinicId/costs?from=&to=` | What the location's calls in the period (ISO times, by start; ended calls) cost us, for the margin page: `{ from, to, currency: 'USD', engines: [{ engine, calls, minutes, voiceUsd, totalUsd }], texts, testCalls: { calls, minutes, voiceUsd, totalUsd }, breakdown: [{ engine, flow, channel, calls, costed, seconds, minutes, voiceUsd, modelUsd, telephonyUsd, textsUsd, totalUsd }] }`. `engines` is phone calls only, one row per engine (`gpt-live`, `gpt-realtime`, `vapi`; `null` for calls closed before migration 0045); `breakdown` splits it by flow (`planner`, `tools`) and channel (`phone`, `web` for browser test calls, never billed) with every cost part. Minutes are each call start to end, as `usage` counts them. Money comes from `call_costs` (the rates table in core `call-costs.ts`; on Vapi, Vapi's own charge per call); `costed` says how many calls have a cost row. `texts` is every text the carrier took in the period. Counts and money only: the hosting layer adds the revenue and its own Twilio prices. 404 for no such clinic. |
| `GET /provisioning/clinics/:clinicId/usage?from=&to=` | Phone calls in the period (ISO times): `{ calls, seconds }`, each call start to end, rounded up to the second. Browser test calls are not counted. |
| `POST /provisioning/clinics/:clinicId/calls-check` | `{ since, from? }`: phone calls that started since `since` (ISO time), ended or not: `{ calls, lastCallAt, heard, openMinutes }`. With `from` (E.164), `heard` says whether one came from that number, compared by its keyed hash (the forwarding check: the owner calls the clinic's own number from a phone); otherwise `null`. `openMinutes` is how long the clinic was open since then, by its hours, holidays and special days, for at most 7 days (a quiet line). A POST, so a number is never in an address. |
| `GET /provisioning/clinics/:clinicId/report?weeks=1` | The weekly report: the clinic's name, time zone, industry and average visit value, its owners with a confirmed address, and the Quality page's numbers for the last whole weeks, newest first. |

## Vapi, a location's backup engine

Attendra's own engine answers every clinic by default. A location can be switched to Vapi (batch 6): its number then reaches a Vapi assistant whose transcriber, model and voice are Vapi's and whose function tools are our tools API, so every rule is still ours (the same CallAgent, booking flow, identity and safety rules as on our engines). The assistant's prompt is the tools voice prompt built from the location's settings; Vapi holds no rule. Calls are recorded as engine `vapi`, flow `tools`, with Vapi's own charge per call on `call_costs`.

The location's number stays in our Twilio account. Switching moves it to our second Elastic SIP trunk (the "Vapi trunk", set up by the hosting layer), whose origination points at Vapi's SIP; Vapi knows the number as a BYO SIP number on that trunk's credential, answered by the location's assistant. No number is bought or imported.

| Route | What it does |
|---|---|
| `PUT /provisioning/clinics/:clinicId/vapi` | Creates or updates the location's assistant from its settings, and its number as a BYO SIP number (on `VAPI_SIP_CREDENTIAL_ID`, answered by that assistant). Body, all optional: `voice` (the location's own voice on Vapi: `{ provider: 'vapi', voiceId }` with one of Vapi's own voices, `{ provider: '11labs', voiceId, model? }` or `{ provider: 'cartesia', voiceId, model? }`; `null` for the default; absent keeps it) and `number` (which of its assigned numbers goes to Vapi; absent, its first). Answers `200 { assistantId, phoneNumberId, sipUri, updatedAt }`: ids only, never the secret. Idempotent: the ids kept in the settings are reused, and one deleted in Vapi's dashboard is made again. Sending it again is the manual resync. `503 vapi_not_configured` (no `VAPI_API_KEY`) or `503 vapi_sip_credential_missing`; `409 no_number` or `409 number_not_assigned`; `502 { error: 'vapi_failed', vapiStatus }` when Vapi refused (what it said is in the API's log, and an alert). Audited (`clinic.vapi.provisioned`). |
| `GET /provisioning/clinics/:clinicId/vapi` | `{ onVapi, assistantId, phoneNumberId, sipUri, updatedAt, inSync, overflowEngine, voice }`: `inSync` is whether the assistant still matches the settings (`null` before there is one). |
| `DELETE /provisioning/clinics/:clinicId/vapi` | Removes the number's resource at Vapi; the assistant stays, for switching again. `204`; `409 on_vapi` while the location is still on Vapi (switch the engine back first). Audited (`clinic.vapi.number_removed`). |
| `PUT /provisioning/clinics/:clinicId/voice-engine` `{ engine: 'vapi' }` | The switch (above): needs the assistant and number (`409 vapi_not_provisioned`), keeps the engine it replaced as `vapi.overflowEngine` and answers `{ previous }`. |
| `GET /provisioning/vapi/concurrency` | `{ now, todayPeak, day, limit, alertAt, alertedAt }`: Vapi calls live at this moment across every location, today's peak (UTC day), the limit (`VAPI_MAX_CONCURRENCY`), the alert's level (70% of it, rounded up) and when today's alert went out. |

**Switching a location to Vapi**, in this order: `PUT .../vapi`; `PUT .../voice-engine { engine: 'vapi' }` (keep `previous`); then the hosting layer moves the number to the Vapi trunk. A call that still reaches our own SIP path in between is answered as usual. **Switching back**: the hosting layer moves the number back to the main trunk; `PUT .../voice-engine { engine: <previous> }`; then `DELETE .../vapi`. A Vapi call already going when the engine is switched back finishes as it is; a new one is refused (its tool calls answer "This call cannot be helped here.", and an alert says the number may still point at Vapi's trunk).

**The per-location secret.** `PUT .../vapi` makes each location its own secret (32 random bytes) the first time, and sends it in the `x-vapi-secret` header of the assistant's server and of each of its tools. The engine keeps it in `vapi_secrets` (migration 0056): encrypted with the deployment's data key (the API sends it again whenever it updates the assistant) and as a keyed hash, which the voice service checks each request against without decrypting. It is never in the settings, a response or a log. The voice service's route takes a request only with the location's own secret, for that location; the deployment-wide `VAPI_SERVER_SECRET` still opens the test clinics (`clinic_bakeoff*`, `clinic_demo*`), and nothing else.

**Settings reach the assistant on their own.** Every save of a location's settings through the API (Settings, Doctors, provisioning) marks it; two seconds later its assistant is updated if the body it is built from changed (its hash, kept as `vapi.syncedHash`). The clinic saves its settings straight to the engine, so the hosting layer never sees a save and could not be the one to call a sync; `PUT .../vapi` is the manual retry when an update failed (said in Slack as `vapi_failed`), and `GET .../vapi` shows `inSync`.

**What our rules do on a Vapi call.** The caller's words go through our guardrails from Vapi's `conversation-update` messages. What they decide goes to the call through its control URL (`call.monitor.controlUrl`, Vapi's hosts only): an emergency script is said at once, word for word, over whatever the model was saying (`say` with `interruptAssistantEnabled`), and the whole instruction goes into the conversation for the model (`add-message`, system); a transfer (`transfer` to a number or SIP address) and the end of a call (`end-call`) follow the line before them, as on our engines. Transfers over the BYO trunk need SIP REFER (call transfer) on the Vapi trunk at Twilio.

**Overflow.** Vapi's limit is calls at the same moment across every location (the subscription's, not a clinic's). The voice service counts them from each call's status messages (`vapi_live_calls`), keeps each day's peak (`vapi_concurrency_days`) and says in Slack, once a day, when the live calls reach 70% of `VAPI_MAX_CONCURRENCY` (default 4, Vapi's free tier; Core is 10, +1 per line bought). When Vapi is full, the call overflows at Twilio (the Vapi trunk's fallback is our own SIP path): our engine answers it with the engine the location had before (`vapi.overflowEngine`), recorded as a call on that engine. A browser test call on a location on Vapi also runs on that engine.

### The SIP trunk credential (once per deployment)

One BYO SIP trunk credential at Vapi serves every location; its id is `VAPI_SIP_CREDENTIAL_ID`. Vapi takes an inbound call only from a source listed as an inbound gateway, matched by numeric IPv4 network, so every Twilio Elastic SIP Trunking signalling range (Twilio's current list, primary and failover edges) is one inbound gateway (`{ ip, netmask, port: 5060, inboundEnabled: true, outboundEnabled: false }`); Twilio's termination host may be added as the outbound one. On the server, with the key in the environment (never in chat):

```sh
pnpm --filter @attendra/api vapi-sip-credential -- --inbound <a.b.c.d/nn,...>              # prints the request, sends nothing
pnpm --filter @attendra/api vapi-sip-credential -- --inbound <a.b.c.d/nn,...> --apply      # creates it, prints the id only
pnpm --filter @attendra/api vapi-sip-credential -- --inbound <...> --update <id> --apply   # replaces its gateways (Twilio's list changed)
```

Twilio's Vapi trunk originates to `sip:<credential id>.sip.vapi.ai` (TLS: `:5061;transport=tls`) with no user part, so Twilio puts the dialled number in the request line; the number resource at Vapi is that number in E.164. `sipUri` in the answer of `PUT .../vapi` is the same address with the number in it, as Vapi's docs write it.

### Environment

| Variable | Service | What it is |
|---|---|---|
| `VAPI_API_KEY` | api (and the credential script) | Vapi's private key. Unset, the Vapi routes answer 503 and no location can be switched. |
| `VAPI_SIP_CREDENTIAL_ID` | api | The trunk credential above. |
| `VAPI_SIP_HOST` | api | Vapi's SIP host for the credential's region: `sip.vapi.ai` (default) or `sip.eu.vapi.ai`. |
| `VAPI_SERVER_URL` | api | The public https address Vapi reaches the voice service at (its `/webhooks/vapi/v1/events`, which the proxy routes to the voice service). Unset, `PUBLIC_URL`. |
| `VAPI_MAX_CONCURRENCY` | api, voice | Vapi calls the subscription takes at once (default 4). Set the same on both. |
| `VAPI_SERVER_SECRET` | voice | Optional: the test clinics' secret (the bake-off). Not needed for a location. |

### Vapi quality settings

Prepared offline (no call measured them); one source of truth, `VAPI_DEFAULTS` in `packages/voice-engine/src/vapi.ts`. The bake-off (2026-11-07, ten web calls, everything at Vapi's defaults) heard lookups answered in 1.85 s median, 2.58 s per reply and a 7.3 s greeting; these settings change the greeting and the end-of-turn wait, which is where that time went.

| Setting | Value | Why, and the trade-off |
|---|---|---|
| First message | the location's greeting, `assistant-speaks-first`, not interruptible | Spoken from the voice alone the moment the call connects: no model round before the first word (the first-audio target is under 3 s on a phone call), and Vapi caches a fixed first message's audio. It cannot be talked over because it is the line that says the caller is speaking with an AI assistant. A model-made greeting would cost a model round. |
| Model | OpenAI `gpt-4.1`, temperature 0.3, at most 250 tokens a reply | The bake-off's: every lookup answered in under 2 s median with no filler. `gpt-4.1-mini` is faster and cheaper but untested on our tools. |
| Transcriber | Deepgram `nova-3`; language `multi` when the location speaks English and Spanish (a caller may switch), else its one language | `multi` booked the Spanish bake-off call. A one-language location gets the more accurate single-language model. |
| End of turn | smart endpointing: LiveKit for an English-only location, Vapi's own when it also speaks Spanish (LiveKit's is English only); `waitSeconds` 0.3 (Vapi's default 0.4) | Faster replies on most turns. Two rules over it: after a question about a number, a phone or a date of birth (English and Spanish) the caller gets 1.5 s of silence before the turn ends, and 1.0 s when their words end in digits, so a number read in pieces is not cut off (path A's lesson). |
| Interruptions | the caller stops the assistant after 0.3 s of speech (Vapi's default 0.2); "okay", "sí", "claro" never do; "no", "wait", "espera" always do; 1 s before it speaks again | Fewer false stops from a bark or a door in a waiting room, at 0.1 s more before a real interruption is heard. Both lists in English and Spanish. |
| Voice | Vapi's own `Elliot` by default (the bake-off's); per location `voice` (above): Vapi's own voices, ElevenLabs (`sarah`, `eleven_flash_v2_5` by default, the fastest that speaks Spanish) or Cartesia (`sonic-3.5`; its voice id from Vapi's Voice Library) | All billed through Vapi: no key of ours at ElevenLabs or Cartesia. ElevenLabs and Cartesia sound better and cost more a minute; Cartesia is usually the fastest to first audio. |
| Background sound | off | Vapi's phone default is an office murmur; our engines play nothing. |
| Longest call | 20 minutes | Vapi's default (10) can end a long call mid-booking. |
| Recording | Vapi records only when the location's own recording setting is on; no SIP packet capture | The location's choice, as on our engines. |
| Live call control | on; listening in off | Our transfers, hang-ups and scripts go through it; nobody listens to a call. |

**What the first phone test must check** (the only proof of these): first audio under 3 s on a real phone call to a number on the Vapi trunk; a booking with a read-back and a yes, and a phone number read in pieces, never cut off; a reply after a lookup in about 2 s or less; talking over the assistant stops it, "okay" does not; a Spanish call books in Spanish; an emergency line ("my dog ate chocolate and is shaking") is answered with our script word for word and the transfer goes through (SIP REFER on the trunk); the call ends after a goodbye; the call shows in the Calls page as Vapi with its cost; the same call with ElevenLabs and with Cartesia, for the voice and the cost a minute; and the concurrency count back to 0 after the calls.

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
