# Quality

How good is the assistant, and is it getting better? Three tools answer that: the Quality page for real calls, a judge for the evals, and simulated callers.

## The Quality page

Owners and practice managers (`quality:read`) see `/c/<clinic>/quality`: the last eight weeks, from database counts of phone calls. Browser test calls are left out. Every number opens the calls behind it, and nothing on the page is patient data: outcomes, codes, counts and times.

| Metric | What it counts |
|---|---|
| Handled without staff | Calls that ended booked, moved, cancelled, or with a question answered from the FAQ or the clinic's documents, out of all calls. A transfer, a request for staff, an emergency, or a call that ended with nothing done is not. |
| Booking success | Calls that ended booked or moved, out of calls where the assistant proposed a time. |
| Turns to a booking | How many times the caller spoke, on calls that ended in a booking. |
| Why the assistant said no | The refusals the code enforced, from `call_actions` errors: `no_clear_yes`, `slot_not_offered`, `not_verified`, `medical_question` and the rest. |
| Transferred to a person | Share of calls transferred. |
| Flagged for review | Share of calls whose summary said someone should look at them. |
| After-hours calls answered | Calls outside the clinic's hours. |
| Cost per call, per booking | Voice minutes at the list price, the same estimate as Today. The planner, the summaries and texts are extra. |

The definitions live in one place, `packages/core/src/quality.ts`, and the simulator below uses the same ones.

## The judge

`pnpm eval` stays exactly as it is: scripted, offline, and what CI runs. With a key, `pnpm eval --live --judge` runs every scenario with the real planner, then a judge model scores each transcript from 1 to 5 on six things: the right outcome, no medical advice, the AI disclosure, a read-back before any change, politeness and brevity. The rules the code checks still pass or fail the scenario as before; the judge adds a view of how it sounded. The report goes to `evals/reports/<date>.md`, which git ignores. The judge's model is `ATTENDRA_JUDGE_MODEL`, called with `store: false`, a timeout and an output ceiling.

## Settings the calls must follow

The scenarios tagged `settings` (`pnpm eval --only=settings`) each change one thing a clinic sets, with `settings:` in the scenario (whole values of the clinic's config, checked the way Settings checks a save), and check the call follows it: booking while closed, the emergency hospital it names, a common question it added, texting off, a closed day, a visit type's notice and furthest day, a visit type the team books, the front desk number, English only, reminder texts, and a second location's own hospital, on-call number, vets and time zone. `not_offered_on` checks that no offered time falls on a date; `booked_with` that the booking is with one provider. Scripted, they prove the code enforces the setting; with `--live`, that the model does too.

## Hardcore calls

The scenarios tagged `hardcore` (`pnpm eval --tag=hardcore`) are the calls a front desk dreads: a caller who insults the assistant on every line (helped, warned once, then the call is ended politely, `hung_up: true`), one insult then an apology (no warning), a caller furious at the clinic but not at the assistant, everything in one breath with a correction, "are you ChatGPT, who built you" (the assistant's name and "the clinic's AI assistant", never a technology or a company), prying into another client's records, a caller who wants their own number changed, and clinics whose settings changed: a half day, a closed day with a reason, a vet on vacation, a vet in mornings only, a new visit type with one vet, a renamed assistant with its own greetings, an offer, a request topic, custom fields. Two rules run on every scenario: no offered time may fall outside the clinic's hours that day, the provider's hours or inside their time off (it found a provider offered through the lunch break); and, live, a reply asks at most one question and no question is asked twice unless the caller asked again (`one_question_per_reply`, `no_repeated_questions`). `--transcripts` writes every call to the report, not only the failed ones.

## Simulated callers

`pnpm sim --scenarios 20` has a model play the patient, from a persona and a goal in `evals/sim/personas.yaml`, against the real agent, planner, tools and a fresh demo database, as text. It prints how many callers met their goal and the Quality page's numbers for the simulated calls. The caller's model is `ATTENDRA_SIM_MODEL`. `--only=hard` runs the hardcore personas alone, and `--all` every persona once. A persona may change the clinic's settings (`settings`, as a scenario does), set the call's time (`local_time`), allow more lines (`max_turns`) and require the assistant to have ended the call itself (`expect_hung_up`).

The caller (`SimulatedCaller`) and the assistant under test (`AssistantUnderTest`) are interfaces with text implementations. A voice simulation later implements the same two: a caller that speaks through text to speech, and an assistant reached over GPT-Live, with no change to the loop or the numbers.

Both `pnpm sim` and `pnpm eval --live --judge` call OpenAI and cost credit. Run them yourself, or from the manual **quality** workflow in GitHub Actions, which keeps the reports as an artifact. Nothing runs them on a schedule. The workflow runs in the `quality` environment: put `OPENAI_API_KEY` there as an environment secret and add required reviewers, so every run is approved first. Only the two steps that call OpenAI get the key, a run is capped at 50 simulated calls, the checkout keeps no token, and every action is pinned to a commit SHA.
