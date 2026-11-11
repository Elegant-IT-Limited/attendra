// SPDX-License-Identifier: AGPL-3.0-only
import { EMERGENCY_CHOICES, emergencyHandlingSummary, RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { world } from './support';

// Note 49 B3: "We handle emergencies, any time (on call)": what does it mean? get_clinic_info carries the setting as
// Settings labels it and its plain words, the same text the core function makes for that setting.
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const NOW = new Date('2026-09-28T16:00:00Z');

it.each([
  ['refer', { mode: 'refer' as const, hospital: { name: 'Front Range Pet Emergency', phone: '+17205550188', address: '1200 Larkspur Avenue, Denver' } }],
  ['handle', { mode: 'handle' as const, number: '+17205550179' }],
  ['hours', { mode: 'hours' as const, number: '+17205550179', afterHoursHospital: { name: 'Night Owl Animal ER', phone: '+17205550189', address: '88 Cedar Road, Denver' } }],
])('%s: the setting and its plain words, as Settings has them', async (mode, emergencies) => {
  const clinic = { ...RIVERBEND_CLINIC, languages: ['en', 'es'] as ('en' | 'es')[], emergencies };
  for (const [lang, said] of [['en', 'What does "we handle emergencies, any time, on call" mean?'], ['es', '¿Qué significa que atienden emergencias a cualquier hora?']] as const) {
    const c = await w.call('+17205550172', { clinic, now: NOW });
    c.caller(said);
    const r = await c.delegate([{ tool: 'get_clinic_info', args: { question: said } }]);
    const info = r.results[0]!.data.emergency_handling as { setting: string; say_if_asked: string };
    expect(info.setting).toBe(EMERGENCY_CHOICES.find((x) => x.value === mode)!.label);
    expect(info.say_if_asked).toBe(emergencyHandlingSummary(clinic, NOW, lang));
  }
});

it('a medicine asked in the same breath is still refused', async () => {
  const clinic = { ...RIVERBEND_CLINIC, languages: ['en', 'es'] as ('en' | 'es')[], emergencies: { mode: 'handle' as const, number: '+17205550179' } };
  for (const said of ['How do you handle emergencies? Can I give him some ibuprofen?', 'Atienden emergencias de guardia, ¿le puedo dar ibuprofeno a mi perro?']) {
    const c = await w.call('+17205550172', { clinic, now: NOW });
    c.caller(said);
    const r = await c.delegate([{ tool: 'get_clinic_info', args: { question: said } }]);
    expect(r.errors, said).toEqual(['medical_question']);
  }
});

it('"what does it mean?" is cut sentence by sentence, and nothing else', async () => {
  const { withoutMeaningAsk } = await import('../src/flow/guards');
  expect(withoutMeaningAsk('Atienden emergencias de guardia, ¿qué significa?').trim()).toBe('Atienden emergencias de guardia,');
  expect(withoutMeaningAsk('What does "on call" mean? Can I give him ibuprofen?')).toContain('Can I give him ibuprofen?');
  expect(withoutMeaningAsk('What does "on call" mean?').trim()).toBe('');
  expect(withoutMeaningAsk('What do you charge for a visit?')).toBe('What do you charge for a visit?');
  // linear on a long run of spaces
  const t0 = Date.now();
  withoutMeaningAsk(`what does${' '.repeat(50_000)}x`);
  expect(Date.now() - t0).toBeLessThan(200);
});
