// SPDX-License-Identifier: AGPL-3.0-only
import { EMERGENCY_LINES, RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './support';

// Call quality R2 (2026-11-19): a caller asking how emergencies are handled heard the danger question twice, and the call
// was labelled "Emergency cleared". Never at the cost of a real one.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };

describe('asked the danger question, a caller who only wanted the information', () => {
  it('hears the clinic\'s handling, and the call has no emergency at all', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('What if my dog has an emergency?');
    c.assistant(EMERGENCY_LINES.question('en'));
    const out = c.caller('Not really, I just need the information.');
    expect(JSON.stringify(out)).toContain('They were asking how the clinic handles emergencies');
    expect(c.state.emergencyCase).toBeNull();
    expect(c.state.emergencyResult).toBeNull();
  });

  it('but with a danger sign in the same words, it is still an emergency', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('What if my dog has an emergency?');
    c.assistant(EMERGENCY_LINES.question('en'));
    const out = c.caller('I just need the information, he is choking right now.');
    expect(JSON.stringify(out)).not.toContain('They were asking how the clinic handles emergencies');
    expect(c.state.emergencyCase).not.toBeNull();
  });

  it('the question already said is never asked again by a clinic-info lookup', async () => {
    const c = await w.call('+17205550172', { clinic });
    c.caller('My dog ate chocolate.');
    c.assistant(EMERGENCY_LINES.question('en'));
    const looked = await c.delegate([{ tool: 'get_clinic_info', args: { question: 'opening hours' } }]);
    expect(looked.errors).toEqual(['emergency_question']);
    expect(JSON.stringify(looked.results)).toContain('Do not ask it again');
  });
});
