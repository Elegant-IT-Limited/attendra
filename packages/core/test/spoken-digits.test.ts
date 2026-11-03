import { describe, expect, it } from 'vitest';
import { asE164, groupedNumber, heardNumber, spokenDigits, withoutSpokenPrefix } from '../src';

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

// A number said with its country prefix ("880 303 555 0130") was read back with it three times and the call gave up
// (2026-11-03). The prefix is dropped when what follows is one whole national number for the clinic's country.
describe('a spoken country prefix', () => {
  const UK = { phoneNumbers: ['+442079460000'] };
  it.each([
    ['880 303 555 0130', '+13035550130'],
    ['eight eight oh, three oh three, triple five, oh one three oh', '+13035550130'],
    ['1 303 555 0130', '+13035550130'],
    ['011 303 555 0130', '+13035550130'],
    ['44 303 555 0130', '+13035550130'],
    ['303 555 0130', '+13035550130'],
  ])('at a US clinic, "%s" is %s', (said, e164) => {
    expect(heardNumber(US, said)).toBe(e164);
    expect(groupedNumber(US, heardNumber(US, said))).toBe('303-555-0130');
  });

  it('keeps what is not a prefix and a whole number after it, and a number said with + or 00', () => {
    expect(withoutSpokenPrefix(US, '880 103 555 0130')).toBe('880 103 555 0130'); // no area code starts with 1
    expect(withoutSpokenPrefix(US, '12 303 555 0130')).toBe('12 303 555 0130'); // 12 is no country's code
    expect(withoutSpokenPrefix(US, '555 0130')).toBe('555 0130');
    expect(heardNumber(US, '+880 303 555 0130')).toBe('+8803035550130');
    expect(heardNumber(US, '00 880 303 555 0130')).toBe('+8803035550130');
  });

  it('elsewhere, with the home 0 said after the prefix', () => {
    expect(heardNumber(UK, '880 20 7946 0123')).toBe('+442079460123');
    expect(heardNumber(UK, '880 020 7946 0123')).toBe('+442079460123');
    expect(heardNumber(UK, '020 7946 0123')).toBe('+442079460123');
  });
});
