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

describe('T4-vad: late turn ends', () => {
  it('T4-vad: the excess of a caller turn kept open past its words (1 s a word plus 1 s), as the longest wait', async () => {
    const { lateTurnEndMs, longestWaitMs } = await import('../src/call-markers');
    const kept = [{ speaker: 'agent' as const, text: '', startMs: 0, endMs: 1500 }, { speaker: 'caller' as const, text: '', words: 3, startMs: 102_995, endMs: 114_085 }, { speaker: 'agent' as const, text: '', startMs: 114_086, endMs: 115_000 }];
    expect(lateTurnEndMs(kept)).toBe(114_085 - 102_995 - 4000);
    expect(longestWaitMs(kept)).toBe(7090);
    const normal = [{ speaker: 'caller' as const, text: '', words: 3, startMs: 0, endMs: 1500 }, { speaker: 'agent' as const, text: '', startMs: 1700, endMs: 2000 }];
    expect(lateTurnEndMs(normal)).toBeNull();
    expect(longestWaitMs(normal)).toBe(200);
  });
});

describe('T4-vad-review: ordinary talk is never a late turn end', () => {
  // a caller piece as CallState keeps it: its word count from the words said (spokenWords), never the words
  const piece = async (said: string, ms: number) => {
    const { spokenWords } = await import('../src/call-markers');
    return [{ speaker: 'caller' as const, text: '', words: spokenWords(said), startMs: 10_000, endMs: 10_000 + ms }, { speaker: 'agent' as const, text: '', startMs: 10_000 + ms + 1, endMs: 10_000 + ms + 900 }];
  };
  const late = async (said: string, ms: number) => {
    const { lateTurnEndMs, lateTurnEnds } = await import('../src/call-markers');
    const pieces = await piece(said, ms);
    return { ms: lateTurnEndMs(pieces), count: lateTurnEnds(pieces) };
  };

  it('T4-vad-review: each digit and each spelled letter is a word; a redacted or not-understood piece has no count', async () => {
    const { spokenWords } = await import('../src/call-markers');
    expect(spokenWords('720-555-0162')).toBe(10);
    expect(spokenWords('B-E-L-L-A, Bella.')).toBe(6);
    expect(spokenWords('Are you there?')).toBe(3);
    expect(spokenWords('My card is [card number removed], thanks')).toBeUndefined();
    expect(spokenWords('[SSN removed]')).toBeUndefined();
    expect(spokenWords('(not understood)')).toBeUndefined();
    expect(spokenWords('4111 1111 1111 1111')).toBeUndefined();
    expect(spokenWords('')).toBeUndefined();
  });

  it("T4-vad-review: the tester's 3 words over 11.1 s is a late turn end of about 7 s", async () => {
    expect(await late('Are you there?', 11_090)).toEqual({ ms: 7090, count: 1 });
  });

  it('T4-vad-review: a phone number said as "720-555-0162" over 5 s is not late', async () => {
    expect(await late('720-555-0162', 5000)).toEqual({ ms: null, count: 0 });
  });

  it('T4-vad-review: 5 grouped-number words over 6 s are not late', async () => {
    expect(await late('seven twenty five fifty five', 6000)).toEqual({ ms: null, count: 0 });
    expect(await late('720 555 01 62 9', 6000)).toEqual({ ms: null, count: 0 });
  });

  it('T4-vad-review: a spelled name "B-E-L-L-A, Bella." over 4.5 s is not late', async () => {
    expect(await late('B-E-L-L-A, Bella.', 4500)).toEqual({ ms: null, count: 0 });
  });

  it('T4-vad-review: 10 digit words over 9 s are not late', async () => {
    expect(await late('seven two zero five five five zero one six two', 9000)).toEqual({ ms: null, count: 0 });
    expect(await late('7 2 0 5 5 5 0 1 6 2', 9000)).toEqual({ ms: null, count: 0 });
  });

  it('T4-vad-review: 40 slow words over 25 s are not late', async () => {
    expect(await late(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '), 25_000)).toEqual({ ms: null, count: 0 });
  });

  it('T4-vad-review: a redacted "[card number removed]" piece over 10 s is not counted', async () => {
    expect(await late('[card number removed]', 10_000)).toEqual({ ms: null, count: 0 });
    expect(await late('It is [SSN removed]', 10_000)).toEqual({ ms: null, count: 0 });
  });

  it('T4-vad-review: the not-understood placeholder is not counted, however long', async () => {
    expect(await late('(not understood)', 12_000)).toEqual({ ms: null, count: 0 });
  });

  it('T4-vad-review: an excess of 4 s or less is not counted; just over 4 s is', async () => {
    expect(await late('Are you there?', 8000)).toEqual({ ms: null, count: 0 });
    expect(await late('Are you there?', 8001)).toEqual({ ms: 4001, count: 1 });
  });
});

// CodeQL js/polynomial-redos (CI on #194–#197): the redaction marker check ran in polynomial time on many '['
describe('REDOS: spokenWords stays fast on hostile input', () => {
  it('REDOS: "[" repeated 50,000 times then "x" is counted in under 50 ms, and the markers are still found', async () => {
    const { spokenWords } = await import('../src/call-markers');
    const t0 = performance.now();
    spokenWords('['.repeat(50_000) + 'x');
    spokenWords('removed]'.repeat(10_000));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(spokenWords('removed] then [SSN removed]')).toBeUndefined();
    expect(spokenWords('It is [card number removed], thanks')).toBeUndefined();
    expect(spokenWords('[SSN removed]')).toBeUndefined();
    expect(spokenWords('(Not Understood)')).toBeUndefined();
    expect(spokenWords('I removed the collar [laughs]')).toBe(5);
  });
});

