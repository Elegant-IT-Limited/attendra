import { describe, expect, it } from 'vitest';
import { type DigestCall, dailyDigest, EMPTY_CALL_MIN_MS, recordedOutcome } from '../src';

const call = (o: Partial<DigestCall> = {}): DigestCall => ({
  clinicId: 'clinic_a', channel: 'phone', outcome: 'booked', closeReason: 'remote_hangup', firstAudioMs: 800, stalls: 0, answerTimeouts: 0, ended: true, ...o,
});

describe('the outcome a call is recorded with', () => {
  it('is no_audio when the caller never heard the assistant and nothing else happened', () => {
    expect(recordedOutcome('abandoned', { firstAudioMs: null })).toBe('no_audio');
    expect(recordedOutcome('abandoned', { firstAudioMs: 900 })).toBe('abandoned');
    // anything that did happen stays what it was
    expect(recordedOutcome('transferred', { firstAudioMs: null })).toBe('transferred');
    expect(recordedOutcome('booked', { firstAudioMs: null })).toBe('booked');
  });

  it('alerts on an empty line only after a greeting could have reached the caller', () => {
    expect(EMPTY_CALL_MIN_MS).toBe(4000);
  });
});

describe('the daily digest', () => {
  it('says a day with no calls in one line', () => {
    expect(dailyDigest([])).toBe('Daily digest, last 24 h: 0 calls (0 phone, 0 browser test), 0 still open. Nothing to report.');
  });

  it('says a clean day is clean, with the first-audio median and p90', () => {
    const text = dailyDigest([call({ firstAudioMs: 600 }), call({ firstAudioMs: 900, channel: 'web' }), call({ firstAudioMs: 1500, ended: false })]);
    expect(text).toContain('3 calls (2 phone, 1 browser test), 1 still open.');
    expect(text).toContain('First audio: median 0.6 s, p90 0.9 s (2 calls measured).');
    expect(text).toContain('No empty lines, stalls, timeouts or drops.');
  });

  it('counts each kind of trouble with the clinics it happened at, most first, and names no caller', () => {
    const text = dailyDigest([
      call({ outcome: 'no_audio', firstAudioMs: null }),
      call({ clinicId: 'clinic_b', outcome: 'no_audio', firstAudioMs: null }),
      call({ clinicId: 'clinic_b', outcome: 'no_audio', firstAudioMs: null }),
      call({ stalls: 2 }), call({ clinicId: 'clinic_b', stalls: 1 }),
      call({ answerTimeouts: 1 }),
      call({ closeReason: 'socket closed 1006 before session.closed' }), call({ closeReason: 'connection_lost' }),
    ]);
    expect(text).toContain('No audio (the caller heard nothing): 3 (clinic_b 2, clinic_a 1).');
    expect(text).toContain('Stalls (5 s of silence after the caller spoke): 3 in 2 calls (clinic_a 1, clinic_b 1).');
    expect(text).toContain('Answers past the 60 s limit: 1 in 1 call (clinic_a 1).');
    expect(text).toContain('Dropped before the end: 2 (clinic_a 2).');
    expect(text).not.toContain('No empty lines');
    expect(text).not.toMatch(/\+?\d{7,}/);
  });

  it('leaves calls still on the line out of the trouble counts', () => {
    const text = dailyDigest([call({ ended: false, outcome: null, firstAudioMs: null, stalls: 1 })]);
    expect(text).toContain('No audio (the caller heard nothing): 0.');
    expect(text).toContain('Stalls (5 s of silence after the caller spoke): 0 in 0 calls.');
  });
});
