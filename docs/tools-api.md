# The tools API (the tools path)

Since batch 1a a clinic's calls can be answered in one of two ways, set per clinic by the operator:

| `voiceFlow` | How a turn is answered | Engines |
|---|---|---|
| `planner` (default) | The voice hands the turn to our backend; the planner (a Responses model) calls the tools and writes the answer; the voice says it. | GPT-Live (client delegation), gpt-realtime (`ask_backend`) |
| `tools` | The voice calls the tools itself and says their results. | gpt-realtime: our tools are its own function tools (path A). GPT-Live: Responses delegation, a Responses model of OpenAI's calls our tools over the sideband (path B). |

Switch: `PUT /api/v1/provisioning/clinics/:clinicId/voice-flow` with `{ "flow": "tools" }`; back with `{ "flow": "planner" }` (or `null`). The engine is `PUT …/voice-engine` as before. Both take effect from the next call; calls in progress finish as they started.

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
