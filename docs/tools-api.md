# The tools API (the tools path)

Since batch 1a a clinic's calls can be answered in one of two ways, set per clinic by the operator:

| `voiceFlow` | How a turn is answered | Engines |
|---|---|---|
| `planner` (absent: the default on a self-hosted install) | The voice hands the turn to our backend; the planner (a Responses model) calls the tools and writes the answer; the voice says it. | GPT-Live (client delegation), gpt-realtime (`ask_backend`) |
| `tools` | The voice calls the tools itself and says their results. | gpt-realtime: our tools are its own function tools (path A). GPT-Live: Responses delegation, a Responses model of OpenAI's calls our tools over the sideband (path B). |

Switch: `PUT /api/v1/provisioning/clinics/:clinicId/voice-flow` with `{ "flow": "tools" }`; back with `{ "flow": "planner" }` (or `null`). The engine is `PUT …/voice-engine` as before. Both take effect from the next call; calls in progress finish as they started.

On the hosted service, every clinic the hosting layer opens (an account, another business, a location) starts on path A: `voiceFlow: tools` with `voiceEngine: gpt-realtime` (`NEW_CLINIC_VOICE` in the provisioning controller). One step back for a clinic is `{ "flow": "planner" }` with `{ "engine": "gpt-live" }`.

## What stays the same

Every tool runs through `runTool` (`packages/agent/src/tools.ts`), on both paths: identity before any record, offered times only, a spoken read-back and a clear yes before any write, idempotency keys, emergency gating, test calls never text or transfer. The emergency guardrail, abuse, injection and leak checks run on the caller's words as before. Only who calls the tools changes.

## The tools and their results

The tools are the planner's (`toolDefinitions(clinic)`, the same JSON schemas) and `clinic_now`. Each result is the same JSON on every engine (`VoiceToolOutput`):

```json
{ "ok": true, "outcome": "times_found", "spoken": "On Tuesday, September 29, I have 8, 8:30 or 9 AM with Dr. Elena Ruiz.",
  "say": "Offer these as written…", "data": { "slots": [ … ] }, "stage": "times_offered", "next": "…" }
```

- `outcome`: what happened (`found`, `booked`, `times_found`…) or the refusal's reason code (`not_verified`, `after_hours`, `slot_taken`…).
- `spoken`: the exact words for the caller, when the tool has them. `say`: how to answer, never read out. `data`: the facts.
- `stage` and `next`: where a visit stands (`idle`, `number_asked`, `number_confirmed`, `pet_chosen`, `times_offered`, `readback_pending`, `done`) and the next step, from `packages/agent/src/flow/booking.ts`.

The prompts on this path (`packages/voice-engine/src/tools-prompt.ts`) carry tone, language, turn-taking and how to use the tools. No clinic policy: no hours, no open or closed, no booking or identity rules.

## The preload

A tools-path call reads the clinic's schedule for 14 days as it starts, and a pet's visits once it is found (`CallCache`, `packages/agent/src/flow/preload.ts`). Lookups answer from it for up to 60 s; a booking or a cancellation goes to the database and drops what was held. The log line `call cache` gives hits and misses per call.

## Over HTTP

`POST /tools/v1/:tool` on the voice service (internal routes, only when `VOICE_INTERNAL_TOKEN` is set), body `{ "call_id": "…", "arguments": { … } }`, bearer: the call's own token, minted when a tools-path call starts and refused once the call has ended. The answer is the same JSON. It is there for an engine that runs outside the voice service (Vapi's tool server, batch 6); nothing calls it yet.

## Measuring

- `pnpm db:call-stats <clinic ids> --since <ISO> --calls`: per clinic, channel, engine and flow: empty calls, first audio, voice-only turns, the lookup answer time (from `answer_timing` rows), filler lines, repeated questions, cost.
- `pnpm --filter @attendra/evals real-audio`: real browser test calls with a voiced caller (see `evals/real-audio/`).
- `call_costs`: what each call cost, by the rates table in `packages/core/src/call-costs.ts`.

## Round 2 (path A)

- **The visit type comes from the clinic.** On the tools path `find_slots` takes only the clinic's own visit type ids (an enum in its schema, with their names); a refusal hands the list back.
- **A likely lookup runs before the reply** (`flow/speculate.ts`): once times are on the table and the visit is known, the voice waits for the caller's words (gpt-realtime only transcribes a turn after it ends); when they ask about a day or a time the lookup runs, and its result goes into the conversation with them, so the voice answers in one reply instead of a tool call and a second reply. It never guesses a visit. The engine replies by itself if no go comes within 1.2 s. **Off by default**: on real audio it saved no time, since waiting for the caller's words costs about as much as the round it saves. `ATTENDRA_LOOKUP_AHEAD=on` (the local demo and the evals read it) turns it on to compare.
- **No narration before a tool**; at most one short phrase when a second tool is needed. A caller who switches language is answered in it, without a second introduction.

## Cost per call (path A, batch 1d)

gpt-realtime reads the whole prompt on every reply: the instructions, the tool definitions, then the conversation. OpenAI's prompt cache bills the part a reply shares with an earlier one at a tenth (text) or an eightieth (audio) of the price, so the layout keeps that part as long as possible:

- **The same instructions and tools on every call of a clinic.** The caller ID and the clinic's date are not in them: they are the conversation's first item (`callFacts`), once.
- **The same short turn note after each caller turn, never removed.** Removing the last one moved every item after it, and the cache missed the rest of the call.
- **Words a tool gives that the next reply must say as written** (its question, its refusal line) go in as a note, then a reply with no tools; never as the reply's own `instructions`, which replace the session's for that reply and miss the cache for the whole call.
- **Compact tool schemas** (no `$schema`, defaults or length limits; nullable strings as a type list): the backend checks every call's arguments against the full schema anyway. A vet clinic's voice gets shorter wording for the six longest tool descriptions (`VET_VOICE_DESCRIPTIONS`); the planner path keeps the full wording.
- **The call's state in a line** (`callStateNote`: who was found, what waits for a yes, what is done), added after the tool results that changed it, and **truncation** (`retention_ratio` 0.7 past 12,000 conversation tokens), so a long call drops its oldest turns now and then without losing where it stands.
- Tools are not cut down by booking stage: a different tool list mid-call misses the cache for everything after it, which costs more than the tokens it saves (measured below).

`pnpm --filter @attendra/evals exec tsx scripts/path-a-cost.ts` lays every scripted scenario out as gpt-realtime would see it and counts the tokens (o200k tokenizer, no API): before and after this layout, each change on its own, tools by stage, and calls back to back (the cache across calls). Audio is estimated from the words (150 a minute; 10 audio tokens a second for the caller, 20 for the voice). An estimate for comparing layouts, not a bill: `call_costs` has the real figure.

**Instructions trimmed (batch 1e).** Path A's instructions leave out the lines and sentences whose rule code enforces on every call, or that a line sent by code already says (`PATH_A_DROPS`, `PATH_A_CUTS` in `tools-prompt.ts`, each with where it is enforced): the record-privacy line (runTool refuses before the pet is found), "are you a real person?", side talk and "why?" (said word for word by the call guards), the callback promise (the promise check), `clinic_now`'s line (its own description, and the call memory fills the date), the goodbye line (folded into the `end_call` line), the number's wording (the call facts), "stop when the caller talks" (the server's `interrupt_response`), and the halves of the security and card lines the security check says when it happens. Tone, language, the greeting and the word-for-word rules stay; GPT-Live and Vapi keep the full lines. Measured with the script on the 413 scripted scenarios, gpt-realtime-2.1: a vet clinic's instructions 2,098 → 1,637 tokens (instructions + tools 4,350 → 3,889); input per call 31,899 → 29,215 tokens; $0.0930 → $0.0906 a call, $0.1155 → $0.1125 a minute ($0.0299 → $0.0295 on the mini); calls back to back $0.0786 → $0.0779 a call.

`PUT /provisioning/clinics/:clinicId/realtime-model` puts one clinic on `gpt-realtime-2.1-mini` for a phone trial; its calls are priced as that model.

## Path C (Vapi), for the bake-off only

A Vapi assistant (Vapi's transcriber, model and voice) whose function tools are ours. Vapi posts its tool calls and call events to `POST /webhooks/vapi/v1/events?clinic=<id>` on the voice service, with the shared secret in `x-vapi-secret` (or as a bearer). Each Vapi call gets the same `CallAgent`, booking flow and safety rules as our own calls; the conversation comes from Vapi's `conversation-update` messages; the end-of-call report closes the call row (`engine: vapi`, `voice_flow: tools`) with its transcript and cost. The route exists only when `VAPI_SERVER_SECRET` is set. No clinic is switched to Vapi; batch 6 builds the real adapter (number re-pointing, back-office switch, concurrency).

- Assistant: `pnpm --filter @attendra/evals vapi-setup -- --url https://<public address of the voice service>` with `VAPI_API_KEY` and `VAPI_SERVER_SECRET` in the environment (creates or updates "Attendra bake-off (demo clinic)").
- Calls: `pnpm --filter @attendra/evals real-audio -- --vapi` with `VAPI_PUBLIC_KEY`: the same voiced calls, through Vapi's web SDK.
