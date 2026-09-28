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

  it('walks nested objects and arrays', () => {
    expect(redact({ turns: [{ speaker: 'caller', text: 'hi' }], meta: { phone: 'x', ms: 1200 } }))
      .toEqual({ turns: [{ speaker: 'caller', text: '[redacted]' }], meta: { phone: '[redacted]', ms: 1200 } });
  });

  it('leaves ordinary ids and durations readable', () => {
    expect(scrubText('session live_123 took 842 ms')).toBe('session live_123 took 842 ms');
  });
});
