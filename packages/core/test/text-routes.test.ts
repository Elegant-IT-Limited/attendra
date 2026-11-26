import { describe, expect, it } from 'vitest';
import { TEXT_ASKS, TEXT_SITUATIONS, TEXT_TABLE, textAskOf, textRoute, textSituationOf } from '../src';

// Batch 1e, item 6: the one table of which text goes when. The agent's tests drive each row through send_text in
// English and Spanish (packages/agent/test/text-table.test.ts); these pin the table itself.
describe('the texts table', () => {
  it('has a cell for every situation and every ask', () => {
    for (const s of TEXT_SITUATIONS) for (const a of TEXT_ASKS) expect(TEXT_TABLE[s][a]).toBeDefined();
  });

  it('an address is an address whichever kind the assistant picked; the emergency text is the hospital', () => {
    expect(textAskOf('directions')).toBe('address');
    expect(textAskOf('answer', true)).toBe('address');
    expect(textAskOf('answer', false)).toBe('answer');
    expect(textAskOf('emergency_hospital')).toBe('hospital');
  });

  it('the address goes to the clinic, the route\'s hospital, or the backup, by where the call is', () => {
    expect(textRoute('calm', 'address')).toEqual({ kind: 'directions', source: 'clinic_address' });
    expect(textRoute('after_booking', 'address')).toEqual({ kind: 'directions', source: 'clinic_address' });
    expect(textRoute('emergency_hospital', 'address')).toEqual({ kind: 'emergency_hospital', source: 'route_hospital' });
    expect(textRoute('emergency_hospital', 'hospital')).toEqual({ kind: 'emergency_hospital', source: 'route_hospital' });
    expect(textRoute('transfer_failed_backup', 'address')).toEqual({ kind: 'emergency_hospital', source: 'route_backup' });
    expect(textRoute('transfer_failed', 'address')).toEqual({ refuse: 'no_hospital' });
    expect(textRoute('emergency_transfer', 'hospital')).toEqual({ refuse: 'emergency_in_progress' });
    expect(textRoute('emergency_question', 'address')).toEqual({ refuse: 'emergency_question' });
    expect(textRoute('calm', 'hospital')).toEqual({ refuse: 'not_an_emergency' });
    // in any emergency, nothing but where to take the animal
    for (const s of ['emergency_hospital', 'emergency_script', 'emergency_transfer', 'transfer_failed_backup', 'transfer_failed'] as const) {
      for (const a of ['hours', 'provider', 'answer', 'link'] as const) expect(textRoute(s, a)).toEqual({ refuse: 'emergency_in_progress' });
    }
  });

  it('reads where the call is from what it knows', () => {
    const e = (stage: 'flagged' | 'asked' | 'escalated' | 'cleared', action: 'refer' | 'transfer' | null = null, transfer: 'none' | 'sent' | 'failed' = 'none', backup = false) => ({ stage, action, transfer, backup });
    expect(textSituationOf({ locked: false, emergency: null, booked: false })).toBe('calm');
    expect(textSituationOf({ locked: false, emergency: null, booked: true })).toBe('after_booking');
    expect(textSituationOf({ locked: false, emergency: e('asked'), booked: false })).toBe('emergency_question');
    expect(textSituationOf({ locked: true, emergency: e('escalated', 'refer'), booked: false })).toBe('emergency_hospital');
    expect(textSituationOf({ locked: true, emergency: e('escalated', 'transfer', 'sent'), booked: false })).toBe('emergency_transfer');
    expect(textSituationOf({ locked: true, emergency: e('escalated', 'transfer', 'failed', true), booked: false })).toBe('transfer_failed_backup');
    expect(textSituationOf({ locked: true, emergency: e('escalated', 'transfer', 'failed'), booked: false })).toBe('transfer_failed');
    expect(textSituationOf({ locked: true, emergency: null, booked: false })).toBe('emergency_script');
    // cleared by the caller: calm again
    expect(textSituationOf({ locked: false, emergency: e('cleared', 'refer'), booked: true })).toBe('after_booking');
  });
});
