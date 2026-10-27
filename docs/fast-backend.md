# How the backend stays fast

The voice model hands each request to the backend planner (`packages/agent/src/planner.ts`), which decides which tools to run and what the voice says next. A caller is waiting the whole time, so the planner is built to take as few model rounds as it can, and to measure itself.

## Where the time goes

Measured on the live evals (2026-10-27): a planner round costs about 1.5 s before its first visible token, whatever it says, and about 0.3 s of words; a round that reasons about dates and times costs 2.5–3 s. Tools take under 0.1 s and the network under 0.3 s. So a request's time is roughly 1.9 s × rounds plus any reasoning. One round is under 2 s; two rounds is 3–4 s; three is 6 s or more.

## Fewer rounds

- **The tool's own sentence is the answer.** A tool that did the whole thing writes the words for it in the call's language (`spoken` in its result): the read-back of a booking with its "Shall I book it?", "All set, that's booked.", the goodbye, a callback or refill taken, a text sent, the reminder answer. When a round made exactly one tool call that returned `ok` with `spoken`, the planner says it and stops: no second round to restate the result. A refusal, an error or a lookup (`verify_caller`, `find_slots`, `get_clinic_info`, …) goes back to the model as before. Nothing is spoken as done before the tool returned `ok`, and `end_call` keeps its rule (asked "anything else?", answered with a no or a goodbye). The lines live in `packages/core/src/locales/{en,es}.ts` under `spoken`.
- **An exact time is staged in one call.** `find_slots` with `propose_if_exact: true`, when a verified caller named one exact day and time that is free, stages it and returns its read-back: one round where there were three (find, propose, answer).

## A prompt the cache can reuse

OpenAI's prompt cache reuses the unchanged start of a request. The planner keeps that start identical across a call's turns: the rules and tool schemas first (byte-identical across turns and minutes, tested), then the call's fixed notes (its records, its caller-ID notes), then the transcript, which only grows. The state line and the clock time come last. The clock used to sit in the first line of the rules, which rewrote the whole prefix every minute. `prompt_cache_key` is the clinic id. `cached_tokens` in each `request answered` log line says what the cache held.

## Settings

- `ATTENDRA_BACKEND_SERVICE_TIER=fast`: priority processing on every round (served as `fast`, recorded per round). It did not lower the first-token floor in the evals but cut the reasoning-heavy rounds from about 4 s to 3 s, at twice the token price (still about a cent per ten call minutes). Unset, the default tier.
- `ATTENDRA_BACKEND_FALLBACK_MODEL` (default `gpt-6.1-terra`, `none` to disable): a round that times out or errors is tried once more on this model and the request stays on it; `fallback: true` in the log. A second failure is the request's: the caller hears the apology and the callback offer.
- `ATTENDRA_BACKEND_EFFORT`, `ATTENDRA_BACKEND_SIMPLE_MODEL`, `ATTENDRA_BACKEND_SIMPLE_EFFORT`: the reasoning effort for every request, and a model or effort for simple turns only. Reasoning `none` on short turns was measured and reverted (2026-10-27): the turns were not faster, and one lost a rule.

## Budgets

- **5 s**: a request still running after 5 s has the voice tell the caller, once, that it is still checking (`HOLD_AFTER_MS`); at 30 and 45 s a thank-you, never "still checking" twice in a row.
- **15 s** per model round (the SDK timeout), **8** rounds per request, **1,000** output tokens per round.
- **60 s**: the answer deadline. Past it the caller hears an apology and a callback offer, and the late answer is dropped. Over 10 s is logged as slow and alerted.

## How to measure

```bash
set -a; . ~/.attendra-evals.env; set +a
pnpm eval --live --judge --timings --only=<scenario ids>
```

`--timings` streams each round (production does not) to time the first visible token, prints every request with its rounds, first-token times, tokens (input / cached, output / reasoning) and tool calls, a breakdown by simple and other turns, and writes `evals/reports/timings-<date>.json`. `--judge` scores each transcript. Compare runs on the same scenarios: median and p90 of simple and other turns, the pass count and the judge means. In production the same numbers are in the `request answered` log line of every call: `model_ms`, `rounds`, `tool_ms`, `prompt_chars`, and `requests[]` with each round's `ms`, `cached_tokens`, `reasoning_tokens` and `calls`.
