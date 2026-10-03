# 10. The dashboard updates from Postgres notices, over one stream per clinic

**Status:** accepted, 2026-10-03

A request the assistant takes, a booking, a patient added, a doctor's new hours: staff should see them without refreshing. Screens used to poll every 30 seconds.

Every write to the tables the dashboard shows fires a trigger that sends `pg_notify('attendra_changes', {clinic, topic})`, where the topic is one of `requests`, `schedule`, `patients`, `calls` or `settings`. The notice names the clinic and the kind of change only: never a row, never patient data. Postgres sends notices when the transaction commits and folds identical ones in one transaction into one, so a bulk import is a single notice.

The API holds one `LISTEN` connection of its own (a pooled connection would drop it), and serves `GET /clinics/:id/changes` as Server-Sent Events to signed-in staff of that clinic. Messages are gathered for 250 ms, a heartbeat keeps proxies from closing the stream, the sign-in is checked again every five minutes, and a stream ends after an hour, when the browser reconnects through the usual checks.

The browser re-reads the screens a change makes stale, through their usual routes, so the role checks and the audit rows are exactly as before. The voice service and the worker need nothing: they write, and Postgres tells the API. The local demo listens on PGlite the same way.

Why not WebSockets or a message broker: the stream only goes one way, SSE reconnects on its own, it passes through the Next proxy, and Postgres is already the one store. If a deployment outgrows one listening connection per API instance, the same notices can feed a broker without changing the browser.
