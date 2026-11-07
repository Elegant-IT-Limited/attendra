# Load test

Before a launch, one question: does a deployment hold twenty calls at once, all day, with every dashboard still live? `pnpm --filter @attendra/web load-test` answers it on a staging deployment. It keeps 20 browser test calls going for 15 minutes, each speaking scripted lines from a WAV file and dialled again when it ends, while it holds 10 dashboard change streams open. Then it reads every call's turn times, counts the drops and, over ssh, the box's CPU and memory, and writes a JSON and a Markdown report with PASS or FAIL.

Never point it at production. Every real call is billed by OpenAI (below), and what the assistant does on a test call is real for that clinic: bookings, cancellations and requests.

It lives in the dashboard's folder (`apps/web/scripts/load-test`) because it drives the dashboard's own Test call page with the same Playwright the e2e suite uses, and its limits are the voice service's own constants, imported, never copied.

## Try it on your laptop first

The dry run places 1 call and holds 1 stream for 1 minute against the local demo, with simulated calls (no audio, no OpenAI), and signs in as a demo login by itself:

```bash
pnpm demo        # or the API and the dashboard on other ports (API_PORT, VOICE_PORT, PUBLIC_URL, API_URL)
pnpm --filter @attendra/web load-test -- --dry-run --base http://localhost:3000
```

It refuses any address but this machine. It exits 0 when a call went live, was measured and the stream held. The report says `INCOMPLETE`: a laptop has no first-audio numbers and no box to sample.

## On staging

What the staging deployment needs:

- **Ten test clinics for twenty calls.** The voice service allows two open browser test calls per clinic (`docs/test-calls.md`); a third is refused with `test_call_limit`, which the report counts as a dropped call. Use made-up patients only.
- **A login on all of them** with a role that makes test calls (owner, admin or front desk), and its session cookie: sign in, open the browser's developer tools on any `/api/v1/me` request and copy the whole `cookie` request header. One session is limited to 600 API requests a minute, shared by every page that uses it; put several sessions in `ATTENDRA_COOKIE`, one header a line, and the calls and streams take them in turn. The report counts every 429.
- **No test-call allowance in the way**: `pnpm db:test-call-limit --clinic <id> --none` for each clinic, and `BROWSER_CALL_MAX_SECONDS` above `--call-seconds`.
- **An idle sign-out longer than the run**: `ATTENDRA_IDLE_MINUTES` of 30 or more. The report notes it when the server's is too short.
- **ssh by key** to the box, for `docker stats` and `db:call-stats` (optional, but without it the CPU, memory and first-audio checks say "not measured" and the verdict cannot pass).

```bash
export ATTENDRA_COOKIE="$(cat ~/staging-sessions.txt)"   # never echo it; the script never prints it
pnpm --filter @attendra/web load-test -- --base https://staging.example.com \
  --clinic clinic_a,clinic_b,clinic_c,clinic_d,clinic_e,clinic_f,clinic_g,clinic_h,clinic_i,clinic_j \
  --calls 20 --streams 10 --minutes 15 --spend --ssh staging [--ssh-port 22022] [--api-container attendra-api-1]
```

Without `--spend` a server with real test calls is refused, with the number of call minutes the run would use. The reports go to `apps/web/load-reports/` (`--out` to change it; the folder is not committed).

| Option | Default | |
|---|---|---|
| `--calls` | 20 | Calls at once. Call *n* starts `--stagger` seconds (3) after call *n−1*. |
| `--call-seconds` | 180 | Each call is hung up after this long and dialled again, so calls start and end all through the run. A call the assistant ends itself (after the caller's goodbye) is dialled again at once. |
| `--streams` | 10 | Change streams held, as a dashboard holds them: a stream that ends comes back after the server's `retry` with its last id. |
| `--minutes` | 15 | |
| `--audio` | the committed lines | One caller's lines, WAV files in order, comma-separated; give `--audio` once per caller. |
| `--gap` | 8 | Seconds of silence after each line, for the assistant's answer. |
| `--ssh` | off | The box: `docker stats` every `--sample` seconds (10), its cores and memory once, and `db:call-stats` at the end, in `--api-container`. |
| `--stats-file` | | `db:call-stats --calls --json` output saved earlier, instead of reading it over ssh. |
| `--report <run.json>` | | Writes the report again from a run's JSON, with no calls (with `--stats-file`, say, after reading the numbers on the box by hand). |

### Where the numbers come from

- **Turn times** are measured exactly as `pnpm db:call-stats` measures them (`statsRow` in `packages/db`): from the caller's last words to the assistant's next words on a turn with no tool, and to the first words after the tool answered on a lookup. With `--ssh` they come from the database; without it, from each call's page in the API (`GET /api/v1/clinics/:id/calls/:callId`, audited as a transcript view), which gives the same turn times but no first audio and no stall counts. The report then prints the `db:call-stats` command to run on the box, and `--report` adds its output.
- **Dropped calls**: a start that was refused or failed, a call that never went live, one the page stopped with an error, and one whose call row ended as dropped (`isDropped` in `packages/core`, the same test as the `call_dropped` alert).
- **CPU and memory**: `docker stats` on the box, every container. Run nothing else on it during the test.

## Thresholds

Every limit is in one block, `THRESHOLDS` in `apps/web/scripts/load-test/thresholds.ts`. A check with nothing to measure says "not measured", and the verdict is then `INCOMPLETE`, never `PASS`.

| Check | Limit | Why |
|---|---|---|
| Turn time p90 | the voice service's first silence nudge, `SILENCE_NUDGE_MS[0]` (5 s) | Past it the caller has spoken and heard nothing: the voice service counts a stall and nudges the model. The planner's turn budget (`HOLD_AFTER_MS`, when the caller hears "still checking") is the same 5 s. |
| First audio p90 | the opening nudge, `OPENING_NUDGE_MS` (2.5 s) | With no greeting by then the voice service prods the model to greet. Needs `db:call-stats`. |
| Dropped calls | 0 | Any call lost under load is a caller lost. |
| Dropped streams | 0 | A dashboard that stops updating. The API ends a stream after 60 minutes by design, longer than any run. |
| Rate-limited answers | 0 | A 429 means a page was turned away by the per-session limit: more sessions, or a limit to look at. |
| Host CPU at peak | 70% of the cores | Every container's CPU together, at the busiest sample: room left for a spike. |
| Container memory at peak | 80% of its `mem_limit` | A container near its limit is killed and restarted by Docker. |

## What a run costs

A browser test call costs what a phone call costs on OpenAI's side: GPT-Live is about $0.05 a minute (`docs/test-calls.md`), plus the backend model for tool steps, about a cent per ten call minutes even on the fast tier (`docs/fast-backend.md`). Twenty calls at once for fifteen minutes is 300 call minutes:

- voice: 300 × $0.05 ≈ **$15**;
- backend model: ≈ $0.30;
- so about **$15 to $20 a run**, every run. A rerun after a fix costs the same; `--minutes 5` costs a third. The dry run and simulated calls cost nothing.

The staging box itself is extra, and is not in this sum.

## The caller's audio

`apps/web/scripts/load-test/audio/lines.json` holds each caller's lines (made up: a check-up for a dog called Biscuit, a question about Saturday hours). The WAVs beside it are those lines as 16 kHz mono files, made with Piper and its LJSpeech voice (`make.sh` says how; run it again when the lines change). For each caller the script joins its lines into one file, with `--gap` seconds of silence after each, and gives it to Chromium's fake microphone (`--use-file-for-fake-audio-capture`). Chromium plays it in a loop for the whole browser, so each caller has a browser of its own and every call in it hears the same lines.

The caller does not wait for the assistant: it speaks on a fixed clock. That is load, not a conversation. Some lines will land while the assistant is still talking (counted as interruptions by `db:call-stats`, not in the turn times). To judge what a caller hears, use the real-audio evals instead.
