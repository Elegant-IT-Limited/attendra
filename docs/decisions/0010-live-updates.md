# 10. The dashboard updates from Postgres notices, over one stream per clinic

**Status:** accepted, 2026-10-03

A request the assistant takes, a booking, a patient added, a doctor's new hours: staff should see them without refreshing. Screens used to poll every 30 seconds.

Every write to the tables the dashboard shows fires a trigger that sends `pg_notify('attendra_changes', {clinic, topic})`, where the topic is one of `requests`, `schedule`, `patients`, `calls` or `settings`. The notice names the clinic and the kind of change only: never a row, never patient data. Postgres sends notices when the transaction commits and folds identical ones in one transaction into one, so a bulk import is a single notice.

The API holds one `LISTEN` connection of its own (a pooled connection would drop it), and serves `GET /clinics/:id/changes` as Server-Sent Events to signed-in staff of that clinic. Messages are gathered for 250 ms, a heartbeat keeps proxies from closing the stream, the sign-in is checked again every five minutes, and a stream ends after an hour, when the browser reconnects through the usual checks.

The browser re-reads the screens a change makes stale, through their usual routes, so the role checks and the audit rows are exactly as before. The voice service and the worker need nothing: they write, and Postgres tells the API. The local demo listens on PGlite the same way.

Why not WebSockets or a message broker: the stream only goes one way, SSE reconnects on its own, it passes through the Next proxy, and Postgres is already the one store. If a deployment outgrows one listening connection per API instance, the same notices can feed a broker without changing the browser.

## Update, 2026-11-07: the person's own changes, replay, and no more polling

- **Topics** now also include `team` (0046), `knowledge` and `texts` (0048), and `live`: the voice service sends it from code (`notifyChange`, at most one per clinic per 500 ms) when a call starts, ends, or moves on, because its live calls are in its memory, not in a table. "Live now" stops polling.
- **A person's own notices** (`me`, migration 0048): an invitation to their address, a role given, changed or removed at any location. The notice names the person (`{user, topic}`), never a clinic. A clinic's stream carries its person's notices too, and `GET /me/changes` serves them alone to pages outside a clinic (the start page, the profile), so an invitation appears in another browser within seconds.
- **Replay:** every message has an id (`<process>.<n>`), and the API keeps the last 60 seconds of notices. A browser that comes back sends `Last-Event-ID`, and the stream's first message (`ready`) says what it missed: some topics, or `*` when the gap cannot be told (the API restarted, the id is older than a minute, or the API's own LISTEN was down). A reconnect that missed nothing refreshes nothing, so the hourly end of a stream is quiet.
- **LISTEN down:** the API retries from half a second up to 10 seconds; down for more than 10 seconds is a Slack alert (`change_notices_down`), and when it is back every open stream is told `*`.
- **Polling:** the screens the stream covers (Today, Calls, Schedule, Requests, Live now, Knowledge, the invitations banner) read on their own only every 2 minutes, as a safety net.
- **Proxy:** in production Caddy sends `/api/v1/clinics/*/changes` and `/api/v1/me/changes` straight to the API with `flush_interval -1` instead of through the Next rewrite (cloud `deploy/Caddyfile.prod`).
