import { describe, expect, it } from 'vitest';
import { ClinicConfig, currentOffers, DEMO_CLINIC, visitTypeFacts } from '../src';

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
