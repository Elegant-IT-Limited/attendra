import { describe, expect, it } from 'vitest';
import { asE164, cleanPhoneTyping, PHONE_NUMBERS_ONLY, phoneProblem, phoneTypingIssues } from '../src';

const US = { phoneNumbers: ['+13035550100'] };

describe('phone fields take numbers only', () => {
  it('refuses letters typed or pasted and a + anywhere but first', () => {
    for (const bad of ['303 CALL NOW', '555-0123 ext', '303+5550123', 'abc', '(303) 555-01x3']) expect(phoneProblem(bad), bad).toBe(PHONE_NUMBERS_ONLY);
    for (const good of ['(303) 555-0123', '303.555.0123', '+1 303 555 0123', '3035550123', '']) expect(phoneProblem(good), good).toBeNull();
  });

  it('every accepted form is still one number', () => {
    const forms = ['(303) 555-0123', '303.555.0123', '+1 303 555 0123', '3035550123', '1 303 555 0123'];
    expect(new Set(forms.map((f) => asE164(US, f)))).toEqual(new Set(['+13035550123']));
  });

  it('cleans what is typed or pasted, and says when it dropped something', () => {
    expect(cleanPhoneTyping('(303) 555-0123')).toEqual({ value: '(303) 555-0123', dropped: false });
    expect(cleanPhoneTyping('303 CALL 5550123')).toEqual({ value: '303  5550123', dropped: true });
    expect(cleanPhoneTyping('+1 303+555')).toEqual({ value: '+1 303555', dropped: true });
    expect(cleanPhoneTyping('+44 20 7946')).toEqual({ value: '+44 20 7946', dropped: false });
  });

  it('finds every phone in Settings typed with letters, by its path, before anything is normalised', () => {
    expect(phoneTypingIssues({
      phoneNumbers: ['+13035550100', '303 555 CALL'],
      vipCallers: [{ name: 'Partner', phone: 'vip 555 0101' }],
      emergencyHospital: { name: 'ER', phone: '303-555-0102', address: 'x' },
      routing: [{ target: 'front_desk', uri: 'tel:303FRONT' }, { target: 'billing', uri: 'sip:billing@example.com' }],
    }).map((i) => i.path)).toEqual(['phoneNumbers.1', 'vipCallers.0.phone', 'routing.0.uri']);
  });
});
