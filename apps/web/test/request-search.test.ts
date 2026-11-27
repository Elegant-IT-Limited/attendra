import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { searchRequests } from '../lib/request-search';

// RPT-batch-11-07-3-2 (review 2026-11-26): one search in the Cmd-K palette is one request to the API, so the API writes
// one tasks.searched audit row. The palette's own query goes through searchRequests; two searches again fail here.
describe('RPT-batch-11-07-3-2: one palette search, one request', () => {
  it('RPT-batch-11-07-3-2: searchRequests sends one POST for open and done requests together, and answers both', async () => {
    const sent: { path: string; body: unknown }[] = [];
    const call = async <T,>(path: string, init: RequestInit) => {
      sent.push({ path, body: JSON.parse(String(init.body)) });
      return { tasks: [{ id: 'a', status: 'open' }, { id: 'b', status: 'done' }] } as T;
    };
    const tasks = await searchRequests('clinic_x', 'R-12', call);
    expect(sent).toEqual([{ path: '/clinics/clinic_x/tasks/search', body: { q: 'R-12', status: 'all' } }]);
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('RPT-batch-11-07-3-2: the palette searches requests only through searchRequests', () => {
    const palette = readFileSync(new URL('../components/command-palette.tsx', import.meta.url), 'utf8');
    expect(palette).toMatch(/queryFn: \(\) => searchRequests\(clinicId, query, api\)/);
    // no second search of its own: one /tasks/search in the palette would be a second audit row
    expect(palette).not.toContain('/tasks/search');
  });
});
