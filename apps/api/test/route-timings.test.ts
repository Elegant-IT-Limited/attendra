import { describe, expect, it } from 'vitest';
import { RouteTimings } from '../src/app';

describe('route timings', () => {
  it('gives p50 and p95 per route, slowest first, then starts again', () => {
    const t = new RouteTimings();
    for (let i = 1; i <= 100; i++) t.add('GET /a', i);
    t.add('GET /b', 500);
    expect(t.drain()).toEqual([{ route: 'GET /b', count: 1, p50: 500, p95: 500 }, { route: 'GET /a', count: 100, p50: 51, p95: 96 }]);
    expect(t.drain()).toEqual([]);
  });
});
