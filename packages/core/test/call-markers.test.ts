// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { maxGapMs, repeatedQuestions } from '../src/call-markers';

const turn = (speaker: 'caller' | 'agent', text: string, startMs: number, endMs: number) => ({ speaker, text, startMs, endMs });

describe('the call markers kept on the call row (CALL-3)', () => {
  it('the longest wait is from the end of a caller turn to the start of the reply after it', () => {
    expect(maxGapMs([turn('agent', 'Hi, how can I help?', 0, 1500), turn('caller', 'Your hours?', 2000, 3000), turn('agent', 'We open at 8.', 3800, 5000),
      turn('caller', 'And Saturday?', 6000, 7000), turn('agent', 'Nine to noon.', 9100, 10000)])).toBe(2100);
  });

  it('is null with no answered caller turn, and a reply over the caller is no wait', () => {
    expect(maxGapMs([turn('agent', 'Hi, how can I help?', 0, 1500)])).toBeNull();
    expect(maxGapMs([turn('agent', 'Hi.', 0, 500), turn('caller', 'Hello, I need', 600, 2000)])).toBeNull();
    expect(maxGapMs([turn('caller', 'Hello?', 0, 1000), turn('agent', 'Hi there.', 900, 1500)])).toBeNull();
  });

  it('counts a question asked again after it was answered, once per repeat', () => {
    const lines = [
      { speaker: 'agent' as const, text: 'What is the phone number on the profile?' },
      { speaker: 'caller' as const, text: '555-0134.' },
      { speaker: 'agent' as const, text: 'What is the phone number on the profile?' },
      { speaker: 'caller' as const, text: 'I just told you.' },
      { speaker: 'agent' as const, text: 'What is the phone number on the profile?' },
    ];
    expect(repeatedQuestions(lines)).toEqual([
      { first: 'What is the phone number on the profile?', again: 'What is the phone number on the profile?' },
      { first: 'What is the phone number on the profile?', again: 'What is the phone number on the profile?' },
    ]);
  });

  it('is no repeat when the caller asked to hear it again, when nothing was said in between, or for a closing question', () => {
    expect(repeatedQuestions([
      { speaker: 'agent', text: 'Which vet would you like to see?' }, { speaker: 'caller', text: 'Sorry, say that again?' }, { speaker: 'agent', text: 'Which vet would you like to see?' },
    ])).toEqual([]);
    expect(repeatedQuestions([{ speaker: 'agent', text: 'Which vet would you like to see?' }, { speaker: 'agent', text: 'Which vet would you like to see?' }])).toEqual([]);
    expect(repeatedQuestions([
      { speaker: 'agent', text: 'Is there anything else I can help with?' }, { speaker: 'caller', text: 'Yes, one thing.' }, { speaker: 'agent', text: 'Is there anything else I can help with?' },
    ])).toEqual([]);
    // an eval's instruction line is neither a question nor an answer
    expect(repeatedQuestions([
      { speaker: 'agent', text: 'Which vet would you like to see?' }, { speaker: 'instruction', text: 'Say the hospital.' }, { speaker: 'agent', text: 'Which vet would you like to see?' },
    ])).toEqual([]);
  });

  it('is the same rule in Spanish (accents and case aside)', () => {
    expect(repeatedQuestions([
      { speaker: 'agent', text: '¿Cuál es el número del perfil de su mascota?' }, { speaker: 'caller', text: 'El 555 0134.' }, { speaker: 'agent', text: '¿Cual es el numero del perfil de su mascota?' },
    ])).toHaveLength(1);
  });
});
