// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { countOf, SMS_TEMPLATE_NAMES, TEXT_GROUPS, TEXT_PARTS, textPreview, textsNotSent } from '../src';

describe('one table of what each text is sent with (texts polish TX1)', () => {
  it('covers every text, and every text is in one group', () => {
    expect(Object.keys(TEXT_PARTS).sort()).toEqual([...SMS_TEMPLATE_NAMES].sort());
    expect(Object.values(TEXT_GROUPS).flat().sort()).toEqual([...SMS_TEMPLATE_NAMES].sort());
  });
  it('a refill text never greets the owner, and always has its number', () => {
    const all = { clinic: 'Harbor Vets', clinicPhone: '+15165550100', name: 'Dana', pet: 'Bella', ref: 'R-43', pharmacy: 'Main Street Pharmacy' };
    expect(textPreview('request_ready', all)).toBe("Harbor Vets: Bella's request (R-43) is ready to pick up. Questions? Call (516) 555-0100. Reply STOP to opt out.");
    expect(textPreview('refill_sent', { ...all, pet: '' })).toBe('Harbor Vets: Your request (R-43) was sent to Main Street Pharmacy. Questions? Call (516) 555-0100. Reply STOP to opt out.');
  });
});

describe('counts read right (TX6)', () => {
  it('one and many', () => {
    expect([countOf(1, 'text'), countOf(2, 'text'), countOf(0, 'item'), countOf(1, 'item')]).toEqual(['1 text', '2 texts', '0 items', '1 item']);
    expect([textsNotSent(1), textsNotSent(2)]).toEqual(['1 text was not sent', '2 texts were not sent']);
  });
});
