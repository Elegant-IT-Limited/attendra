import { describe, expect, it } from 'vitest';
import { ClinicConfig, currentOffers, DEMO_CLINIC, readCustomValues, visitTypeFacts } from '../src';

describe('what a clinic customises', () => {
  it('shows offers only between their dates', () => {
    const c = { offers: [
      { id: 'a', title: 'Vaccine clinic', details: 'Saturdays', from: '2026-10-01', to: '2026-10-31' },
      { id: 'b', title: 'Always on', details: 'Every day' },
      { id: 'c', title: 'Not yet', details: 'Soon', from: '2026-11-01' },
    ] };
    expect(currentOffers(c, '2026-10-20').map((o) => o.title)).toEqual(['Vaccine clinic', 'Always on']);
    expect(currentOffers(c, '2026-11-02').map((o) => o.title)).toEqual(['Always on', 'Not yet']);
    expect(currentOffers({}, '2026-10-20')).toEqual([]);
  });

  it('keeps a visit type as it was when nothing is customised', () => {
    expect(visitTypeFacts(DEMO_CLINIC, 'en')[0]).not.toHaveProperty('description');
    expect(visitTypeFacts(DEMO_CLINIC, 'en')[0]).not.toHaveProperty('booked_by');
  });

  it('checks links, offers and credentials', () => {
    const ok = ClinicConfig.safeParse({ ...DEMO_CLINIC, menuLinks: [{ label: 'ezyVet', url: 'https://ezyvet.example' }] });
    expect(ok.success).toBe(true);
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, menuLinks: [{ label: 'Bad', url: 'http://x.example' }] }).success).toBe(false);
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, offers: [{ id: 'o', title: 'Backwards', details: 'Dates wrong', from: '2026-10-31', to: '2026-10-01' }] }).success).toBe(false);
    const p = { ...DEMO_CLINIC.providers[0]!, credentials: ['x'] };
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, providers: [p] }).success).toBe(false);
  });
});

describe("the clinic's own fields on a record", () => {
  const fields = [{ id: 'chip', label: 'Microchip', kind: 'text' as const }, { id: 'insured', label: 'Insured', kind: 'yesno' as const }, { id: 'due', label: 'Rabies due', kind: 'date' as const }];

  it('keeps trimmed values, leaves empty ones out, and checks each kind', () => {
    expect(readCustomValues(fields, { chip: ' 985 ', insured: 'no', due: '' })).toEqual({ ok: true, values: { chip: '985', insured: 'no' } });
    expect(readCustomValues(fields, { insured: 'maybe' })).toMatchObject({ ok: false, field: 'insured' });
    expect(readCustomValues(fields, { due: '1 May' })).toMatchObject({ ok: false, field: 'due' });
    expect(readCustomValues(fields, { chip: 'x'.repeat(201) })).toMatchObject({ ok: false, field: 'chip' });
    expect(readCustomValues(fields, { other: 'x' })).toMatchObject({ ok: false, field: 'other' });
  });

  it('refuses two fields with the same id', () => {
    const r = ClinicConfig.safeParse({ ...DEMO_CLINIC, customFields: [fields[0], { ...fields[1], id: 'chip' }] });
    expect(r.success).toBe(false);
    expect(ClinicConfig.safeParse({ ...DEMO_CLINIC, customFields: fields }).success).toBe(true);
  });
});
