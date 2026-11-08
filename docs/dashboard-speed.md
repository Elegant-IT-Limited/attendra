# Dashboard speed

How fast the dashboard has to feel, how each part is measured, and where the numbers live in the code. Note 17 of the
2026-11-02 feedback: from far away every request is a round trip of about 280 ms, so the work is to make fewer of them,
smaller, and never one after another.

## The budget

| What | Budget | Where it is checked |
| --- | --- | --- |
| A click shows its result (save, toggle, move) | under 100 ms | optimistic updates (`apps/web/lib/optimistic.ts`): shown at once, rolled back with a message on error |
| A page change, from the US | under 300 ms | data asked for ahead (below), the previous data kept on screen while new data comes |
| A page change, from far away (Asia) | under 700 ms | the same, plus compression: the round trip is most of it |
| One API route on the server, p95 | under 200 ms | `ROUTE_P95_BUDGET_MS` in `apps/api/src/app.ts`: a minute where a route goes over it logs `routes over budget` |
| The Schedule's Day grid or Agenda, its render alone, 200 vets | under 1000 ms | `RENDER_BUDGET_MS` in `apps/web/e2e/schedule-scale.spec.ts`, the same on a laptop and on CI |

The budgets are never raised to make a check pass. A check that fails under load is made to measure the right thing
instead (note 29: the render check measures the grid's render, not the dev server).

## Measuring on the server

- **Server-Timing** on every API answer: `app;dur=<ms>` is the whole of the server's time, `db;dur=<ms>;desc="<n> queries"`
  the time its database queries took, summed (queries run side by side can add up to more than `app`). The browser's
  network panel shows both under Timing; the rest of a request's time is the network. The database time is measured per
  request by `measureDb` and `timeQueries` in `packages/db/src/timing.ts`: times and counts only, never SQL or values.
- **The log**: one `request` line per answer with the method, the route pattern (never the URL: a query string can
  carry PHI), the status, `ms`, `dbMs` and `queries`; and once a minute a `route timings` line with p50 and p95 per route,
  slowest first, plus `routes over budget` when a route's p95 passed the budget. To read them on a server:
  `docker compose logs api | grep '"route timings"'`.
- **Compression**: JSON and text answers of 1 KB or more go out with brotli (gzip for a browser without it) and
  `Vary: Accept-Encoding` (`apps/api/src/http/compress.ts`, node's own zlib). JSON shrinks to well under half: the
  demo clinic's settings go from 3.3 KB to 1.3 KB, its vets from 1.4 KB to 0.5 KB.
- **Keep-alive**: a connection stays open 72 s after an answer (`KEEP_ALIVE_MS`), longer than the dashboard's proxy
  keeps an idle one, so the next request reuses it.

## In the browser

- **Asked for ahead**: Today's first answers go out with "who am I" on the way into a clinic (the clinic layout). A
  sidebar link pointed at, focused or touched asks for its page's first answers (`apps/web/lib/page-data.ts`): Patients,
  Doctors, Team, Quality and Test call. The page reads the same key, so nothing is asked for twice; anything fetched in
  the last 15 seconds is not asked for again. Schedule, Requests, Calls and Settings depend on the page's own state (a
  day, filters, a versioned copy): Next fetches their code ahead and their data comes with the page.
- **The previous data stays on screen** while a list is refetched or narrowed (`placeholderData: keepPreviousData`), so
  there is no blank or spinner flash.
- **Today asks for each answer once**: `apps/web/e2e/speed.spec.ts` counts every API request Today makes on the way in
  and fails on any asked for twice.
- **Render marks**: the Schedule's grids leave a `performance.measure` for each render (`schedule-grid`,
  `schedule-agenda`, `apps/web/lib/render-mark.ts`). The browser's performance panel shows them under Timings.
