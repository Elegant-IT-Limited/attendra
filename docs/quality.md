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

## Simulated callers

`pnpm sim --scenarios 20` has a model play the patient, from a persona and a goal in `evals/sim/personas.yaml`, against the real agent, planner, tools and a fresh demo database, as text. It prints how many callers met their goal and the Quality page's numbers for the simulated calls. The caller's model is `ATTENDRA_SIM_MODEL`.

The caller (`SimulatedCaller`) and the assistant under test (`AssistantUnderTest`) are interfaces with text implementations. A voice simulation later implements the same two: a caller that speaks through text to speech, and an assistant reached over GPT-Live, with no change to the loop or the numbers.

Both `pnpm sim` and `pnpm eval --live --judge` call OpenAI and cost credit. Run them yourself, or from the manual **quality** workflow in GitHub Actions, which uses the repository's `OPENAI_API_KEY` secret and keeps the reports as an artifact. Nothing runs them on a schedule.
