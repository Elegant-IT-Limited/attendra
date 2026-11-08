import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KEEP_ALIVE_MS, overBudget, ROUTE_P95_BUDGET_MS, RouteTimings } from '../src/app';
import { COMPRESS_MIN_BYTES } from '../src/http/compress';

describe('route timings', () => {
  it('gives p50 and p95 per route, slowest first, then starts again', () => {
    const t = new RouteTimings();
    for (let i = 1; i <= 100; i++) t.add('GET /a', i);
    t.add('GET /b', 500);
    expect(t.drain()).toEqual([{ route: 'GET /b', count: 1, p50: 500, p95: 500 }, { route: 'GET /a', count: 100, p50: 51, p95: 96 }]);
    expect(t.drain()).toEqual([]);
  });

  it('warns about the routes over the budget, leaving out the streams that stay open by design and one-off answers', () => {
    const rows = [
      { route: 'GET /api/v1/clinics/:clinicId/calls', count: 40, p50: 90, p95: ROUTE_P95_BUDGET_MS + 1 },
      { route: 'GET /api/v1/clinics/:clinicId/overview', count: 40, p50: 50, p95: ROUTE_P95_BUDGET_MS },
      { route: 'GET /api/v1/clinics/:clinicId/changes', count: 9, p50: 60_000, p95: 60_000 },
      { route: 'GET /api/v1/clinics/:clinicId/calls/:callId/live', count: 9, p50: 60_000, p95: 60_000 },
      { route: 'POST /api/v1/clinics/:clinicId/doctors/import', count: 1, p50: 900, p95: 900 },
    ];
    expect(overBudget(rows).map((r) => r.route)).toEqual(['GET /api/v1/clinics/:clinicId/calls']);
  });

  it('the documented budget is the one the code checks', () => {
    const doc = readFileSync(new URL('../../../docs/dashboard-speed.md', import.meta.url), 'utf8');
    expect(doc).toContain(`| One API route on the server, p95 | under ${ROUTE_P95_BUDGET_MS} ms |`);
    expect(doc).toContain(`stays open ${KEEP_ALIVE_MS / 1000} s`);
    expect(doc).toContain(`answers of ${COMPRESS_MIN_BYTES / 1024} KB or more`);
  });
});
