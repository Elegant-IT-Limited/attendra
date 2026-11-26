// SPDX-License-Identifier: AGPL-3.0-only
import { RIVERBEND_CLINIC } from '@attendra/core';
import { seedRiverbend } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { slotArgsAsMeant } from '../src/tools';
import { world } from './support';

// Call quality Q8 (2026-11-18): find_slots came back invalid_arguments on both paths, and the record showed nothing more.
describe('find_slots arguments as the model meant them', () => {
  it('reads "none", a time without its zero or with seconds, a date with a time, "evening" and "true"', () => {
    expect(slotArgsAsMeant({ visit_type_id: 'vt_sick', provider_id: 'none', provider_gender: 'any', time_mode: 'exact', part_of_day: null, from_time: '9:00', from_date: '2026-09-29T00:00:00', propose_if_exact: 'true', specialty: 'none' }))
      .toEqual({ visit_type_id: 'vt_sick', provider_id: null, provider_gender: null, time_mode: 'at', part_of_day: 'any', from_time: '09:00', from_date: '2026-09-29', propose_if_exact: true, specialty: null });
    expect(slotArgsAsMeant({ part_of_day: 'evening', from_time: '4 pm' })).toMatchObject({ part_of_day: 'afternoon', from_time: '16:00' });
    expect(slotArgsAsMeant({ from_time: '09:30:00' })).toMatchObject({ from_time: '09:30' });
  });
});

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => { w = await world(seedRiverbend); }, 60_000);
afterAll(() => w.t.close());

describe('find_slots on a call', () => {
  const clinic = { ...RIVERBEND_CLINIC, afterHours: 'book' as const };
  it('finds times with those arguments instead of refusing them', async () => {
    const c = await w.call('+17205550172', { clinic });
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit' } }]);
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: '2026-09-29', part_of_day: null, from_time: '9:00', time_mode: 'none', provider_gender: 'any', specialty: null, propose_if_exact: null } }]);
    expect(out.errors).toEqual([null]);
  });

  it('records which argument did not fit and how, never its value', async () => {
    const c = await w.call('+17205550172', { clinic });
    await c.delegate([{ tool: 'verify_caller', args: { owner_name: 'Linh', pet_name: 'Biscuit' } }]);
    const out = await c.delegate([{ tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: 'whenever the rash clears', part_of_day: 'any' } }]);
    // (a day in words is read as meant since T12: only a date that names no day is refused)
    expect(out.errors).toEqual(['invalid_arguments']);
    expect(out.results[0]!.data.invalid_fields).toEqual(['from_date:invalid_format:string']);
    expect(JSON.stringify(out.results[0]!.data.invalid_fields)).not.toContain('rash');
  });
});
