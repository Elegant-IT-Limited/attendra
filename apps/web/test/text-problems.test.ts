import { describe, expect, it } from 'vitest';
import { problemHref, problemLine, unseen } from '../lib/text-problems';

// Note 2026-11-16 (demo findings 3, item 4): a text not sent after the panel closed is still said, once per browser.
const p = (o: Partial<Parameters<typeof problemLine>[0]> = {}) => ({ textId: 't1', taskId: 'task-1', number: 37, type: 'refill', taskStatus: 'done' as const, status: 'failed', failureReason: null, errorCode: '30006', at: '2026-11-16T10:00:00.000Z', ...o });

describe('texts about requests that were not sent', () => {
  it('in the history\'s words, with the request', () => {
    expect(problemLine(p(), 'pet')).toBe('R-37 · Prescription refill: Text not sent: the carrier refused it (error 30006)');
    expect(problemLine(p({ status: 'not_sent', failureReason: 'opted_out', errorCode: null }), 'pet')).toBe('R-37 · Prescription refill: Text not sent: the number has opted out (replied STOP)');
  });
  it('open the request in the list it is in', () => {
    expect(problemHref('clinic_a', p())).toBe('/c/clinic_a/requests?status=done&open=task-1');
    expect(problemHref('clinic_a', p({ taskStatus: 'open' }))).toBe('/c/clinic_a/requests?open=task-1');
  });
  it('each is said once, oldest first', () => {
    const list = [p({ textId: 'b', at: '2026-11-16T11:00:00.000Z' }), p({ textId: 'a' }), p({ textId: 'c' })];
    expect(unseen(list, new Set(['c'])).map((x) => x.textId)).toEqual(['a', 'b']);
  });
});
