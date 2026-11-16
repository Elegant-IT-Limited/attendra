# The QA export: a day of calls for quality review

Someone who reviews how the assistant answered (a QA lead, a script that runs each morning) reads one clinic day of calls at a time, read-only, with a key made for it. Nothing in it can book, cancel, text or change a setting.

## The key

An owner or practice manager makes a key under **Settings > API keys** and ticks **Daily call export for quality review** (`qa:read`). Give it its own key with only that scope. Like every key it belongs to one clinic, has an expiry (7 days to a year), is shown once, and stops working the moment it is revoked or its maker is no longer an owner or practice manager there ([mcp.md](mcp.md), "Keys").

`qa:read` works only on the export below, and only to read: the same key on any other route, or on a write, is refused (`401 api_key_not_accepted`), and another clinic's id answers `404`. A key without `qa:read` gets `403`, and the refusal is audited under the key. An owner or practice manager signed in to the dashboard may read the export too.

## The request

```
GET /api/v1/clinics/<clinic id>/qa/export?day=YYYY-MM-DD
Authorization: Bearer <key>
```

`day` is the clinic's own day, in its time zone (Settings > General). Leave it out for yesterday by the clinic's clock. For example, with placeholder values:

```bash
ATTENDRA_QA_KEY=atk_...   # the key, from Settings > API keys (better: from your secrets store)
curl -s -H "Authorization: Bearer $ATTENDRA_QA_KEY" \
  "https://attendra.example.com/api/v1/clinics/clinic_example/qa/export?day=2026-11-16"
```

At most 30 reads an hour per key (`429 rate_limited` with `Retry-After` past that). Every read is written to the clinic's audit log as `qa.export`, with the key's id (`api_key:<id>`) or the person's, and the number of calls and transcript lines it returned; the key's "Last used" moves.

## What comes back

```json
{
  "day": "2026-11-16", "timezone": "America/Denver", "truncated": false,
  "calls": [{
    "id": "…", "path": "gpt-realtime/tools", "startedAt": "…", "endedAt": "…", "durationS": 94,
    "endReason": "caller_hangup", "outcome": "booked", "testCall": false,
    "requests": [{ "number": 1042, "kind": "callback", "status": "open", "urgent": false, "origin": null, "outcome": null }],
    "bookings": [{ "change": "booked", "status": "booked", "visitTypeId": "vt_wellness", "startsAt": "…" }],
    "texts": [{ "template": "booking_confirmed", "kind": "auto", "status": "delivered", "errorCode": null }],
    "events": { "count": 412, "callerTurns": 9, "stalls": 0, "replyMs": [640, 910], "gate": { "gate.sent.reply": 11 }, "errors": {} },
    "transcript": [{ "speaker": "caller", "startMs": 0, "endMs": 2100, "text": "Hi, my number is [number]." }]
  }],
  "numbers": [{ "path": "gpt-realtime/tools", "calls": 12, "stalls": { "status": "measured", "value": 1 }, "yesDisagreements": { "status": "not_measured", "reason": "…" } }]
}
```

- **Each call**: its path (engine and how its turns were answered), times, end reason, outcome, whether it was a browser test call, and what it did: requests (kind and status), visits it booked or cancelled (visit type, status, time), and texts (kind and status; never the words that went out).
- **`events`**: the call's event log summed up (stalls, reply times, the turn gate's decisions, the provider's error codes), or `null` for a call with no log (before this release, or more than 7 days ago). The whole timeline of one call: `pnpm db:call-events <call id>`.
- **`transcript`**: the words as said, with every run of 4 or more digits (phone numbers, codes, years) as `[number]`, written dates as `[date]`, a date of birth as `[date]` (on a line about a birthday, or the answer right after the question), and emails as `[email]`. Names and times stay. `null` when the call has no transcript: nobody spoke, or the clinic's retention has cleared it.
- **`numbers`**: the day per call path, the same as `pnpm db:call-numbers <clinic id> [day]`: stalls (no reply started within 5 s of the caller stopping), reply time p50 and p90, refusal loops (the same tool refusal 3 or more times in a call), lines that talk about how the assistant works, and yes-disagreements. A number that cannot be measured yet says `not_measured` with the reason; none is made up.
- `truncated` is true on a day with more than 1,000 calls: the first 1,000, oldest first.

The export carries names and what callers said: treat it as PHI. Whoever runs the script that reads it, and any model it is passed to, needs a BAA before it is used with real patients ([hipaa.md](hipaa.md)).

## The event log behind it

Every call on gpt-realtime, GPT-Live and Vapi keeps a log of what the provider sent and when (types, ms from the call's start, response and item ids, and for an error its code and type), never content, plus the turn gate's own decisions (`gate.queued.reply`, `gate.cleared_on_error`…) and the runner's nudges. It is written in batches (every few seconds and at the call's end), kept 7 days, and deleted by the worker's nightly retention job with an audit row of counts (migration 0060, `call_events`).
