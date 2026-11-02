import { describe, expect, it } from 'vitest';
import { asE164, groupedNumber, spokenDigits } from '../src';

const US = { phoneNumbers: ['+13035550100'] };

describe('a number as people say it', () => {
  it('reads double and triple, in words or digits, and Spanish doble', () => {
    expect(spokenDigits('double eight zero three, triple five, oh one three oh')).toBe('88 0 3, 555, 0 1 3 0');
    expect(spokenDigits('three oh three, triple 5, zero one three zero').replace(/\D/g, '')).toBe('3035550130');
    expect(spokenDigits('tres cero tres, cinco cinco cinco, cero uno tres cero').replace(/\D/g, '')).toBe('3035550130');
    expect(spokenDigits('doble ocho').replace(/\D/g, '')).toBe('88');
    expect(asE164(US, spokenDigits('three zero three, five five five, zero one double three'))).toBe('+13035550133');
  });

  it('keeps "double" when the digit comes in the next piece of speech', () => {
    expect(spokenDigits('three oh three five five five oh one double').concat(' ', spokenDigits('three')).replace(/\D/g, '')).toBe('303555013');
    // the planner joins the pieces before it passes them: the repeat reaches across the space
    expect(spokenDigits('303 555 01 double, three').replace(/\D/g, '')).toBe('3035550133');
  });

  it('leaves letters where they are, so a number with letters is still refused', () => {
    expect(spokenDigits('call me at abc')).toBe('call me at abc');
  });

  it('reads a number back in groups', () => {
    expect(groupedNumber(US, '+13035550130')).toBe('303-555-0130');
    expect(groupedNumber(US, '(303) 555 0130')).toBe('303-555-0130');
    expect(groupedNumber(US, '7205550174')).toBe('720-555-0174');
  });
});
