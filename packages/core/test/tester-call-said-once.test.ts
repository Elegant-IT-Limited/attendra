// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import * as core from '../src';

// T9, a tester's call (2026-11-24): "One moment. One moment.", a sentence said twice in one turn, and "wrap up
// smoothly.This demo call ends" with no space.
describe('T9: lines joined to be said once, with a space between sentences', () => {
  it('T9: joinSaid says each sentence once and puts a space after each', () => {
    const { joinSaid } = core as unknown as { joinSaid?: (...parts: (string | null)[]) => string };
    expect(typeof joinSaid).toBe('function');
    expect(joinSaid!('One moment.', 'One moment.')).toBe('One moment.');
    expect(joinSaid!('I have Tuesday at 9:00 AM. Shall I book it?', 'Shall I book it?')).toBe('I have Tuesday at 9:00 AM. Shall I book it?');
    expect(joinSaid!('We can wrap up smoothly.', 'This demo call ends in about a minute.')).toBe('We can wrap up smoothly. This demo call ends in about a minute.');
    expect(joinSaid!('Un momento.', null, 'Un momento.')).toBe('Un momento.');
    // different sentences stay, in order; Dr. and times keep their dots
    expect(joinSaid!('Dr. Ruiz is free at 9.30.', 'Shall I book it?')).toBe('Dr. Ruiz is free at 9.30. Shall I book it?');
  });

  it('T9: spacedSentences puts the missing space back, and leaves titles, decimals and initials alone', () => {
    const { spacedSentences } = core as unknown as { spacedSentences?: (t: string) => string };
    expect(typeof spacedSentences).toBe('function');
    expect(spacedSentences!('We can wrap up smoothly.This demo call ends in about a minute.')).toBe('We can wrap up smoothly. This demo call ends in about a minute.');
    expect(spacedSentences!('Le aviso.Esta llamada termina pronto.')).toBe('Le aviso. Esta llamada termina pronto.');
    for (const same of ['Dr.Ruiz', 'It costs 9.50.', 'U.S.A.', 'example.com']) expect(spacedSentences!(same)).toBe(same);
  });
});
