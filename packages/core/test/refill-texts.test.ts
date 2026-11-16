import { describe, expect, it } from 'vitest';
import { REFILL_NO_TEXT, refillText } from '../src';

// Note 2026-11-16 RF2: which refill decisions text the caller, the one rule the worker sends by and the labels say.
describe('which refill decisions text the caller', () => {
  const fromCall = (details: Record<string, string>) => ({ type: 'refill', fromCall: true, details });
  it('each decision its own text, to a caller who said yes on the call', () => {
    expect(refillText('refill_ready', fromCall({ texts: 'yes' }))).toEqual({ template: 'request_ready' });
    expect(refillText('refill_declined', fromCall({ texts: 'yes' }))).toEqual({ template: 'refill_not_approved' });
    expect(refillText('refill_sent', fromCall({ texts: 'yes', pharmacy: 'Main St Pharmacy' }))).toEqual({ template: 'refill_sent', pharmacy: 'Main St Pharmacy' });
  });
  it('none to a caller who did not say yes; a request the team wrote down texts unless it says no', () => {
    for (const details of [{}, { texts: 'no' }] as Record<string, string>[]) expect(refillText('refill_ready', fromCall(details))).toEqual({ none: 'no_consent' });
    expect(refillText('refill_ready', { type: 'refill', fromCall: false, details: {} })).toEqual({ template: 'request_ready' });
    expect(refillText('refill_ready', { type: 'refill', fromCall: false, details: { texts: 'no' } })).toEqual({ none: 'no_consent' });
  });
  it('"sent to the pharmacy" only with a pharmacy to name, never one picked up at the clinic', () => {
    for (const pharmacy of [undefined, '', 'pick up at the clinic', 'Pickup', 'recoger en la clínica']) {
      expect(refillText('refill_sent', fromCall({ texts: 'yes', ...(pharmacy !== undefined ? { pharmacy } : {}) }))).toEqual({ none: 'no_pharmacy' });
    }
  });
  it('nothing for another outcome or another kind of request', () => {
    for (const o of ['called_back', 'left_message', 'not_needed', null, undefined]) expect(refillText(o, fromCall({ texts: 'yes' }))).toBeNull();
    expect(refillText('refill_ready', { type: 'callback', fromCall: true, details: { texts: 'yes' } })).toBeNull();
  });
  it('says why none in plain words', () => {
    expect(REFILL_NO_TEXT).toEqual({ no_consent: 'the caller did not say yes to texts', no_pharmacy: 'no pharmacy named' });
  });
});
