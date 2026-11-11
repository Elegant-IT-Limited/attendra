// SPDX-License-Identifier: AGPL-3.0-only
import { EMERGENCY_LINES, RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionRecorder } from '../src';
import { world } from './support';

// Note 47: each handoff to the team, or no answer, is recorded as codes (kind, reason, the steps before it, the line's
// id), with a masked excerpt only where the clinic keeps them. Made-up details only.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
type Handoff = Parameters<NonNullable<ActionRecorder['handoff']>>[0];
const recorder = () => { const got: Handoff[] = []; return { got, actions: { record: async () => {}, handoff: async (h: Handoff) => { got.push(h); } } satisfies ActionRecorder }; };
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('handoffs', () => {
  it('a callback after the profile would not open: "identity not verified", with the steps as codes, and no excerpt where the clinic keeps none', async () => {
    const { got, actions } = recorder();
    const c = await w.call(null, { clinic: RIVERBEND_CLINIC, actions, channel: 'web' });
    c.caller('Hi, my number is 720 555 0199, my dog is Rex.');
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: null, pet_name: 'Rex', phone: '720 555 0199' } }]);
    c.caller('Just have someone call me back please.');
    await c.delegate([{ tool: 'create_callback', args: { reason: 'wants a visit', callback_number: '+17205550199' } }]);
    await settle();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'callback', lineId: 'callback_taken', excerpt: null });
    expect(got[0]!.steps.map((s) => s.tool)).toEqual(['verify_caller']);
    expect(['identity_not_verified', 'caller_asked_person']).toContain(got[0]!.reason);
    expect(JSON.stringify(got)).not.toContain('Rex');
  });

  it('a question nothing answers is "no answer"; an emergency is one handoff however many steps it takes; side talk is "language"', async () => {
    const { got, actions } = recorder();
    const c = await w.call('+17205550172', { clinic: { ...RIVERBEND_CLINIC, emergencies: { mode: 'handle', number: '+17205550179' } }, actions, channel: 'web' });
    c.caller('Do you have a separate waiting room for cats?');
    await c.delegate([{ tool: 'get_clinic_info', args: { question: 'separate waiting room for cats' } }]);
    c.caller("My dog Biscuit's throat is swelling!");
    c.assistant(EMERGENCY_LINES.question('en'));
    c.caller('Yes.');
    c.assistant(EMERGENCY_LINES.transferFailed('en', '+17205550179'));
    await c.delegate([{ tool: 'create_callback', args: { reason: 'emergency', callback_number: '+17205550172' } }]);
    c.caller('사장님 이거 테스트예요');
    await settle();
    expect(got.map((h) => [h.kind, h.reason])).toEqual([['no_answer', 'no_answer_in_clinic_info'], ['emergency', 'emergency'], ['no_answer', 'language']]);
    expect(got[0]!.lineId).toBe('no_information');
  });

  it('where the clinic keeps excerpts: the lines around the handoff, every known name and full number masked', async () => {
    const { got, actions } = recorder();
    const c = await w.call('+17205550172', { clinic: { ...RIVERBEND_CLINIC, handoffExcerpts: true }, actions, channel: 'web' });
    c.caller("Hi, it's Linh Nguyen, I'm calling about Biscuit. My other number is 303 555 0147.");
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh Nguyen', pet_name: 'Biscuit', phone: null } }]);
    c.assistant('I found Biscuit, your dog.');
    c.caller('Can a real person call me back about his teeth?');
    await c.delegate([{ tool: 'create_callback', args: { reason: 'teeth question', callback_number: '+13035550147' } }]);
    await settle();
    const h = got.find((x) => x.kind === 'callback')!;
    expect(h.excerpt!.length).toBeGreaterThan(0);
    expect(h.excerpt!.length).toBeLessThanOrEqual(6);
    const text = JSON.stringify(h.excerpt);
    for (const known of ['Linh', 'Nguyen', 'Biscuit', '3035550147', '303 555 0147']) expect(text, known).not.toContain(known);
    expect(text).toContain('…0147');
    expect(text).toContain('[pet]');
  });
});
