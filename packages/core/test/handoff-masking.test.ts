// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { handoffExcerpt, maskExcerptLine } from '../src';

// Note 47, Level 2 rule 5: no known name or full number survives masking, in English and Spanish. Made-up details only.
const NAMES = { people: ['Linh Nguyen', 'Daniel Brooks', 'Carmen Ortiz'], pets: ['Biscuit', 'Mochi', 'Peppér'], vets: ['Dr. Alma Sato', 'Ruiz'] };
const KNOWN = ['Linh', 'Nguyen', 'Daniel', 'Brooks', 'Carmen', 'Ortiz', 'Biscuit', 'Mochi', 'Pepper', 'Alma', 'Sato', 'Ruiz'];
const FULL = ['7205550172', '5550172', '720555', '3035550147'];
const survives = (masked: string) => [
  ...KNOWN.filter((n) => new RegExp(`\\b${n}\\b`, 'i').test(masked)),
  ...FULL.filter((d) => masked.replace(/\D/g, '').includes(d)),
  ...(/@/.test(masked) ? ['an email'] : []),
];

describe('masking an excerpt before it is stored', () => {
  it.each([
    "Hi, this is Linh Nguyen, I'm calling about Biscuit and Mochi.",
    'My number is (720) 555-0172, or +1 303 555 0147.',
    'It is seven two zero, five five five, zero one seven two.',
    'Seven two zero double five five oh one seven two.',
    'Can Dr. Sato see him? Or Dr. Ruiz? Alma said Tuesday.',
    'Email me at linh.nguyen@example.com please.',
    'We live at 1200 Larkspur Avenue, Denver.',
    "It's for my neighbour Daniel Brooks's rabbit Pepper.",
  ])('English: "%s"', (line) => {
    const masked = maskExcerptLine(line, NAMES);
    expect(survives(masked), masked).toEqual([]);
  });

  it.each([
    'Hola, soy Carmen Ortiz, llamo por mi perro Biscuit.',
    'Mi número es el siete dos cero, cinco cinco cinco, cero uno siete dos.',
    'Es el 720 555 0172.',
    '¿La doctora Sato o el doctor Ruiz pueden verlo?',
    'Mi correo es carmen.ortiz@example.com.',
    'Vivo en calle Mayor 12, y la gata se llama Mochi.',
    'Es para la coneja Peppér de Daniel Brooks.',
  ])('Spanish: "%s"', (line) => {
    const masked = maskExcerptLine(line, NAMES);
    expect(survives(masked), masked).toEqual([]);
  });

  it('keeps what is needed to judge the handoff: the words, the last 4 of a number, times and short numbers', () => {
    expect(maskExcerptLine('My number is (720) 555-0172. Can I come at 3:30 on the 12th?', NAMES)).toBe('My number is …0172. Can I come at 3:30 on the 12th?');
    expect(maskExcerptLine('I want to talk to a real person about Biscuit.', NAMES)).toBe('I want to talk to a real person about [pet].');
    expect(maskExcerptLine('Dr. Sato, please.', NAMES)).toBe('Dr. [vet], please.');
    expect(maskExcerptLine('Linh here.', NAMES)).toBe('[name] here.');
  });

  it('takes the lines from about 30 s before the handoff to it, at most 6, each masked', () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ speaker: (i % 2 ? 'agent' : 'caller') as 'caller' | 'agent', text: `Line ${i} for Biscuit, 720 555 0172.`, startMs: i * 5000, endMs: i * 5000 + 4000 }));
    const got = handoffExcerpt(turns, 46_000, NAMES);
    expect(got).toHaveLength(6);
    expect(got[0]!.text).toBe('Line 4 for [pet], …0172.');
    expect(got.at(-1)).toEqual({ speaker: 'assistant', text: 'Line 9 for [pet], …0172.' });
    expect(handoffExcerpt(turns, 4000, NAMES).map((l) => l.text)).toEqual(['Line 0 for [pet], …0172.']);
  });
});
