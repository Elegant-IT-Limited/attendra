import { describe, expect, it } from 'vitest';
import { soundsLike, spokenKey } from '../src/identity';

// a name said on the phone against a name on file: spelled any way, heard the same (2026-11)
describe('soundsLike', () => {
  it.each([
    ['Mini', 'Minnie'], ['Mini', 'Meeny'], ['Pepper', 'Peppa'], ['Sofia', 'Sophia'], ['Catherine', 'Kathryn'],
    ['Mohammad', 'Muhammad'], ['Biscuit', 'Bisquit'], ['Mochi', 'Moochi'], ['Max', 'Macks'], ['Luna', 'Loona'], ['Bella', 'Bela'],
    ['Zoë', 'Zoe'], ['JUNIPER', 'juniper'], ['Mini ', ' mini'],
  ])('%s sounds like %s', (said, onFile) => {
    expect(soundsLike(said, onFile)).toBe(true);
    expect(soundsLike(onFile, said)).toBe(true);
  });

  it.each([
    ['Mini', 'Max'], ['Biscuit', 'Bailey'], ['Priya', 'Puspa'], ['Mini', 'Jenny'], ['Max', 'Mochi'], ['Luna', 'Lola'],
    ['Pepper', 'Clover'], ['Bella', 'Biscuit'], ['', 'Mini'], ['Mini', ''],
  ])('%s does not sound like %s', (said, onFile) => {
    expect(soundsLike(said, onFile)).toBe(false);
  });

  it('keys only the first word, without accents, case or punctuation', () => {
    expect(spokenKey('Sofía Marie')).toBe(spokenKey('sofia'));
    expect(spokenKey('Mr. Biscuit')).toBe(spokenKey('mr'));
  });
});
