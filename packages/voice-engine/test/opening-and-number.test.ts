import { DEMO_CLINIC, RIVERBEND_CLINIC } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { vi } from 'vitest';
import { CallMarks, callerIdLine, GptLiveEngine, noCallerIdLine } from '../src';

// the number question and the opening (2026-11-14): the profile number for a booking, the best number for a callback
// only, and one log line that says where the gap after the greeting was
describe('a browser call at a clinic for animals', () => {
  const clinic = { ...RIVERBEND_CLINIC, languages: ['en', 'es'] as ('en' | 'es')[] };
  it('asks the number the pet\'s profile is under, at once and without the backend, never the best number', () => {
    const line = noCallerIdLine(clinic);
    expect(line).toContain('"Sure. What phone number is your pet\'s profile under?" or "Claro. ¿Con qué número de teléfono está registrada la ficha de su mascota?"');
    expect(line).toContain('Only when the caller wants to book, move or cancel a visit, first ask, yourself, before handing anything to the backend');
    expect(line).toContain('For questions (prices, hours, how long a visit takes, what a visit includes), just answer, with no number question.');
    expect(line).not.toMatch(/best number|mejor número/);
  });
});

// Option C (2026-11-14): the voice is told from the start, and judges itself whether the caller wants a visit
describe('a call with caller ID at a clinic for animals', () => {
  const clinic = { ...RIVERBEND_CLINIC, languages: ['en', 'es'] as ('en' | 'es')[] };
  const NOW = new Date('2026-09-28T16:00:00Z');
  const fake = () => {
    const create = vi.fn(async () => ({ session: { id: 'live_web' }, transport: { type: 'webrtc', sdp: 'v=0 answer' } }));
    const sessions = { accept: vi.fn(async () => {}), refer: vi.fn(async () => {}), hangup: vi.fn(async () => {}), reject: vi.fn(async () => {}) };
    return { engine: new GptLiveEngine({ live: { create, sessions } } as unknown as OpenAI), create, sessions };
  };

  it('has the number question for a visit only, with the last four digits, in every language the clinic speaks', () => {
    const line = callerIdLine(clinic, '+13035550142')!;
    expect(line).toContain('ending 0142');
    expect(line).toContain('"Sure. Is your pet\'s profile under the number you\'re calling from, ending 0142?" or "Claro. ');
    expect(line).toContain('Only when the caller wants to book, move or cancel a visit');
    expect(line).toContain('just answer, with no number question');
  });

  it('is in a phone call\'s instructions from the start, and in a browser call\'s started as a number', async () => {
    const { engine, create, sessions } = fake();
    await engine.accept('live_sip', clinic, NOW, undefined, { callerNumber: '+13035550142' });
    await engine.accept('live_hidden', clinic, NOW);
    await engine.startBrowserCall(clinic, 'v=0 offer', NOW, { callerNumber: '+13035550142' });
    const accepted = (sessions.accept.mock.calls as unknown as [string, { session: { instructions: string } }][]).map((c) => c[1].session.instructions);
    expect(accepted[0]).toContain(callerIdLine(clinic, '+13035550142')!);
    expect(accepted[1]).not.toContain('Caller ID shows'); // a hidden number
    const web = (create.mock.calls[0] as unknown as [{ session: { instructions: string } }])[0].session.instructions;
    expect(web).toContain(callerIdLine(clinic, '+13035550142')!);
    expect(web).not.toContain('there is no caller ID');
  });

  it('is never a person clinic\'s', () => {
    expect(callerIdLine(DEMO_CLINIC, '+13035550142')).toBeNull();
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
