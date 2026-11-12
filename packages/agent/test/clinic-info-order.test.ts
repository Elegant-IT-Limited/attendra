// SPDX-License-Identifier: AGPL-3.0-only
import { seedRiverbend } from '@attendra/db';
import { RIVERBEND_CLINIC } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const providers = (out: { results: { data: Record<string, unknown> }[] }) => (out.results[0]!.data.providers as { name: string }[]).map((p) => p.name);

// note 52 B8: a caller asked for the vets "from last to first" and the model was left to turn the list round
describe('get_clinic_info hands the vets over in the order the caller asked', () => {
  it('as listed when no order is asked, reversed for "from last to first", and says it is already in order', async () => {
    const c = await w.call(null, { clinic, channel: 'web' });
    c.caller('Who are your vets?');
    const listed = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'Who are your vets?' } }]);
    expect(providers(listed).length).toBeGreaterThan(1);
    expect(listed.results[0]!.data.providers_order).toBeUndefined();
    c.caller('Can you say them from last to first?');
    const reversed = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'the vets, from last to first' } }]);
    expect(providers(reversed)).toEqual([...providers(listed)].reverse());
    expect(reversed.results[0]!.data.providers_order).toContain('in the order the caller asked');
    c.caller('Alphabetically, please.');
    const alpha = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'the vets alphabetically' } }]);
    const bare = (n: string) => n.replace(/^Dr\.?\s+/, '');
    expect(providers(alpha).map(bare)).toEqual([...providers(listed).map(bare)].sort((a, b) => a.localeCompare(b)));
  });
});
