import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redact, scrubText } from '../src';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({ write(chunk, _enc, done) { lines.push(chunk.toString()); done(); } });
  return { log: createLogger({ name: 'test', destination }), lines };
}

// Synthetic values only; the point is that none of them survive to the output.
const PHI = ['Maria Delgado', '1985-03-04', '3/4/1985', 'March 4th, 1985', '+1 (303) 555-0147', '303.555.0147', 'maria.d@example.com', 'chest pain', 'lisinopril'];

describe('the redacting logger', () => {
  it('replaces PHI fields and scrubs PHI patterns in everything it writes', () => {
    const { log, lines } = capture();
    log.info({ call_id: 'call_1', full_name: 'Maria Delgado', dob: '1985-03-04', transcript: 'I have chest pain', medication: 'lisinopril' }, 'verifying caller');
    log.warn({ call_id: 'call_1', detail: 'caller gave 3/4/1985 and +1 (303) 555-0147, email maria.d@example.com' }, 'lookup failed');
    log.error({ err: new Error('no match for March 4th, 1985 at 303.555.0147') }, 'tool error');
    const out = lines.join('\n');
    for (const value of PHI) expect(out).not.toContain(value);
    expect(out).toContain('call_1'); // the useful, non-PHI context is kept
    expect(out).toContain('[redacted]');
  });

  it('scrubs the message string too, not only the object', () => {
    const { log, lines } = capture();
    log.info('callback requested for 303-555-0147');
    expect(lines.join('')).not.toContain('555-0147');
  });

  it('replaces the note staff type on an appointment, and what they typed into patient search', () => {
    expect(redact({ appointment_id: 'appt_1', note: 'Wheelchair access needed.' })).toEqual({ appointment_id: 'appt_1', note: '[redacted]' });
    expect(redact({ route: '/patients/search', query: 'delgado' })).toEqual({ route: '/patients/search', query: '[redacted]' });
  });

  it('walks nested objects and arrays', () => {
    expect(redact({ turns: [{ speaker: 'caller', text: 'hi' }], meta: { phone: 'x', ms: 1200 } }))
      .toEqual({ turns: [{ speaker: 'caller', text: '[redacted]' }], meta: { phone: '[redacted]', ms: 1200 } });
  });

  it('scrubs numbers from outside North America and dates written day first or in Spanish', () => {
    for (const value of ['+44 20 7946 0958', '+442079460958', '020 7946 0958', '07700 900123', '+61 2 9374 4000', '+34 612 345 678',
      '4 March 1985', '4th of March, 1985', '4 de marzo de 1985', '29 de septiembre']) {
      expect(scrubText(`caller said ${value} earlier`), value).not.toContain(value);
    }
    // a count, a duration and an id stay readable
    expect(scrubText('3 retries after 1500 ms for job 42 of 2026')).toBe('3 retries after 1500 ms for job 42 of 2026');
  });

  it('leaves ids that hold digits alone, and still scrubs a national number beside them', () => {
    const uuid = '01234567-1234-4abc-8def-0123456789ab';
    expect(scrubText(`call ${uuid} ended`)).toBe(`call ${uuid} ended`);
    expect(scrubText('call_id call_0123456789 ended')).toBe('call_id call_0123456789 ended');
    expect(scrubText(`call ${uuid}: caller gave 020 7946 0958`)).toBe(`call ${uuid}: caller gave [phone]`);
  });

  it('leaves ordinary ids and durations readable', () => {
    expect(scrubText('session live_123 took 842 ms')).toBe('session live_123 took 842 ms');
  });
});
