import { RIVERBEND_CLINIC } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { CallMarks, noCallerIdLine } from '../src';

// the number question and the opening (2026-11-14): the profile number for a booking, the best number for a callback
// only, and one log line that says where the gap after the greeting was
describe('a browser call at a clinic for animals', () => {
  const clinic = { ...RIVERBEND_CLINIC, languages: ['en', 'es'] as ('en' | 'es')[] };
  it('asks the number the pet\'s profile is under, at once and without the backend, never the best number', () => {
    const line = noCallerIdLine(clinic);
    expect(line).toContain('"Sure. What phone number is your pet\'s profile under?" or "Claro. ¿Con qué número de teléfono está registrada la ficha de su mascota?"');
    expect(line).toContain('ask at once, yourself, before handing anything to the backend');
    expect(line).not.toMatch(/best number|mejor número/);
  });
});

describe('opening timing', () => {
  it('measures the gap before the caller spoke and after, and whether the reply was the backend\'s', () => {
    const marks = new CallMarks(1_000);
    marks.greetingWords(800, 2_000);
    marks.greetingWords(4_200, 4_000); // the greeting's last words end at 4.2 s on the audio timeline
    expect(marks.replyStarted(5_000)).toBeNull(); // nobody has spoken yet
    marks.callerWords(6_000, 6_500);
    marks.greetingWords(9_999, 6_600); // the assistant over the caller: not the greeting
    marks.callerWords(6_000, 7_000);
    marks.delegation();
    const line = marks.replyStarted(9_800);
    expect(line).toEqual({
      greeting_end_to_caller_ms: 1_800, caller_end_to_reply_ms: 2_800, reply_was_delegated: true,
      greeting_end_ms: 3_000, first_caller_ms: 5_500, first_reply_ms: 8_800,
    });
    // once only
    expect(marks.replyStarted(12_000)).toBeNull();
  });

  it('a reply the voice gave itself is not delegated', () => {
    const marks = new CallMarks(0);
    marks.greetingWords(3_000, 3_000);
    marks.callerWords(3_500, 4_000);
    expect(marks.replyStarted(4_300)).toMatchObject({ caller_end_to_reply_ms: 300, reply_was_delegated: false, greeting_end_to_caller_ms: 500 });
  });
});
