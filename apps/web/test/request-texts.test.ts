import { describe, expect, it } from 'vitest';
import { noTextYet, outcomeChoice, requestMissing, requestTextLine, TASK_HISTORY, TASK_OUTCOMES } from '../lib/format';

// Note 2026-11-16 RF1-RF5: refills closed with a decision that says whether it texts, and what became of the text.
const refill = (details: Record<string, string>, callId: string | null = 'call-1') => ({ type: 'refill', callId, details });

describe('a refill\'s outcomes (RF1, RF2)', () => {
  it('name each decision, and whether it texts on this request, by the worker\'s rule', () => {
    expect(TASK_OUTCOMES.refill_sent).toBe('Sent to the pharmacy');
    expect(outcomeChoice('refill_ready', refill({ texts: 'yes' }))).toBe('Approved, ready to pick up (texts the caller)');
    expect(outcomeChoice('refill_declined', refill({ texts: 'yes' }))).toBe('Not approved (texts the caller to call us)');
    expect(outcomeChoice('refill_sent', refill({ texts: 'yes', pharmacy: 'Main St Pharmacy' }))).toBe('Sent to the pharmacy (texts the caller)');
    expect(outcomeChoice('refill_sent', refill({ texts: 'yes', pharmacy: 'pick up' }))).toBe('Sent to the pharmacy (no text: no pharmacy named)');
    expect(outcomeChoice('refill_ready', refill({}))).toBe('Approved, ready to pick up (no text: the caller did not say yes to texts)');
    expect(outcomeChoice('called_back', refill({ texts: 'yes' }))).toBe('Called back');
  });
});

describe('what became of the text (RF3)', () => {
  const text = (status: string, o: { failureReason?: string; errorCode?: string; toLast4?: string } = {}) => ({ status, failureReason: o.failureReason ?? null, errorCode: o.errorCode ?? null, toLast4: o.toLast4 ?? '0101' });
  it('the same line for the history and the toast, with the number it went to', () => {
    expect(requestTextLine(text('sent'), '+15165550101')).toBe('Text sent to (516) 555-0101');
    expect(requestTextLine(text('delivered'), '+15165550101')).toBe('Text delivered to (516) 555-0101');
    expect(requestTextLine(text('not_sent', { failureReason: 'not_textable' }), '+15165550101')).toBe('Text not sent: texts go only to mobile numbers in your country, never premium or toll-free ones');
    expect(requestTextLine(text('failed', { errorCode: '21211' }), '+15165550101')).toBe('Text not sent: the carrier refused it (error 21211)');
    // the number on the request changed since: the last four of the one it went to
    expect(requestTextLine(text('sent', { toLast4: '0199' }), '+15165550101')).toBe('Text sent to the number ending 0199');
  });
  it('a decision that sends no text says why, in the history and on the closed request', () => {
    expect(TASK_HISTORY['task.text.none.no_consent']).toBe('No text sent: the caller did not say yes to texts');
    expect(TASK_HISTORY['task.text.none.no_pharmacy']).toBe('No text sent: no pharmacy named');
    expect(noTextYet({ ...refill({}), outcome: 'refill_ready' })).toBe('No text sent: the caller did not say yes to texts.');
    expect(noTextYet({ ...refill({ texts: 'yes' }), outcome: 'refill_ready' })).toBe('No text recorded yet. It goes out within a minute of closing.');
  });
});

describe('New request says what is missing (RF4)', () => {
  it('a refill with its medicine is enough; anything else needs a sentence', () => {
    expect(requestMissing({ kind: 'refill', reason: '', medication: 'Carprofen 75 mg' })).toBeNull();
    expect(requestMissing({ kind: 'refill', reason: '', medication: '' })).toBe('Add the medicine, or say what it is about.');
    expect(requestMissing({ kind: 'callback', reason: '', medication: '' })).toBe('Add "What it is about".');
    expect(requestMissing({ kind: 'callback', reason: 'ok', medication: '' })).toBe('Say a little more in "What it is about".');
    expect(requestMissing({ kind: 'callback', reason: 'Wants a dental cleaning', medication: '' })).toBeNull();
  });
});
