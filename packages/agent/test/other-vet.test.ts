// SPDX-License-Identifier: AGPL-3.0-only
import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asksOtherVet } from '../src/tools';
import { world } from './support';

// Call quality R5 (2026-11-19): "Only Maya Chen is available? Can you offer any other doctor?" heard Dr. Chen's three
// morning times again, as "the openings are with Dr. Maya Chen only".
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());
const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
const slots = (out: { results: { data: Record<string, unknown> }[] }) => (out.results[0]!.data.slots ?? []) as { provider_id?: string; provider?: string }[];

describe('any other doctor', () => {
  it('is asking for another vet, in English and Spanish', () => {
    for (const t of ['Can you offer any other doctor?', 'Is there another vet?', 'Someone else, please', '¿Hay otro veterinario?', '¿Con otra doctora?']) expect(asksOtherVet(t), t).toBe(true);
    for (const t of ['Dr. Chen is fine', 'Any time is fine', 'Other than that, nothing']) expect(asksOtherVet(t), t).toBe(false);
  });

  for (const lang of ['en', 'es'] as const) {
    it(`offers the other vets' times, never the same vet's again (${lang})`, async () => {
      const c = await w.call('+17205550172', { clinic });
      c.caller(lang === 'es' ? 'Hola, soy Linh, quiero una consulta por enfermedad para Biscuit mañana.' : 'Hi, Linh here, a sick visit for Biscuit tomorrow please.');
      await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit' } }]);
      const first = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-09-29', part_of_day: 'any' } }]);
      const firstVets = new Set([...c.state.offered.values()].map((s) => s.providerId));
      expect(firstVets.size).toBeGreaterThan(0);
      void first;
      c.caller(lang === 'es' ? '¿Solo esa doctora? ¿Hay otro veterinario?' : 'Only that doctor? Can you offer any other doctor?');
      const before = new Set(c.state.offered.keys());
      const again = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-09-29', part_of_day: 'any' } }]);
      expect(again.errors).toEqual([null]);
      const fresh = [...c.state.offered.entries()].filter(([id]) => !before.has(id)).map(([, s]) => s.providerId);
      expect(fresh.length).toBeGreaterThan(0);
      expect(fresh.every((p) => !firstVets.has(p))).toBe(true);
      void slots;
    });
  }
});
