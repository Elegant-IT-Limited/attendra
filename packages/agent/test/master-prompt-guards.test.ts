import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// Step 4 (master prompt robustness): the rules code can enforce, enforced. Made-up data.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const lines = (out: { type: string; content?: string }[]) => out.map((o) => (o.type === 'instructions' ? o.content ?? '' : '')).join(' ');

describe('MP-HEAR: "can you hear me?" is answered at once, in a few words', () => {
  it('MP-HEAR: EN and ES, every time it is asked', async () => {
    const c = await w.call('+13035550181', { clinic });
    expect(lines(c.caller('Hello? Can you hear me?'))).toContain('Yes, I can hear you.');
    c.assistant('Yes, I can hear you.');
    expect(lines(c.caller('Can you hear me now?'))).toContain('Yes, I can hear you.');
    const es = await w.call('+13035550182', { clinic });
    es.state.language = 'es';
    expect(lines(es.caller('¿Hola? ¿Me escucha?'))).toContain('Sí, le escucho.');
    c.assistant('Yes, I can hear you.');
    expect(lines(c.caller('I hear a dog barking, sorry.'))).not.toContain('I can hear you');
  });
});

describe('MP-INTERNAL: internal state said out loud is corrected once', () => {
  it('MP-INTERNAL: "The tentative change won\'t be used" gets a correction to say the action plainly', async () => {
    const c = await w.call('+13035550183', { clinic });
    c.caller('Hi.');
    const out = c.agent.onAgentTranscript("The earlier tentative change won't be used.", 5_000, 5_900);
    expect(lines(out)).toMatch(/internal|how you work/i);
    expect(lines(c.agent.onAgentTranscript('The pending change is dropped.', 7_000, 7_900))).toBe('');
  });
});
