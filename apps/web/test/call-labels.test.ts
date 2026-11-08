import { CALL_OUTCOMES, EMERGENCY_RESULTS as RESULT_CODES } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { CLOSE_REASONS, closeReasonLabel, EMERGENCY_RESULTS, OUTCOMES, waitWords } from '../lib/format';

// CALL-2 (batch 4b): one label table for each code a call carries, and every code has its plain label.
describe('the labels on Calls and the call page', () => {
  it('every outcome a call can end with has a label, no_audio included, and no label is for an outcome that does not exist', () => {
    for (const o of CALL_OUTCOMES) expect(OUTCOMES[o]?.label, o).toMatch(/^[A-Z][a-z ]+$/);
    expect(Object.keys(OUTCOMES).sort()).toEqual([...CALL_OUTCOMES].sort());
    expect(OUTCOMES.no_audio.label).toBe('Caller heard nothing');
  });

  it('every way an emergency can end has a label and a line, and nothing else does', () => {
    for (const r of RESULT_CODES) {
      expect(EMERGENCY_RESULTS[r]?.label, r).toBeTruthy();
      expect(EMERGENCY_RESULTS[r]?.text, r).toMatch(/\.$/);
    }
    expect(Object.keys(EMERGENCY_RESULTS).sort()).toEqual([...RESULT_CODES].sort());
  });

  it('says how a call ended in plain words, the batch 1e silent start included, and never shows a raw code or a log note', () => {
    expect(closeReasonLabel('silent_start')).toBe('Assistant never spoke: passed on or ended');
    expect(closeReasonLabel('caller_hangup')).toBe('Caller hung up');
    expect(closeReasonLabel('socket closed 1006 before session.closed')).toBe('Connection dropped');
    expect(closeReasonLabel('transport failed: busy')).toBe('Phone line did not connect');
    expect(closeReasonLabel('pipeline-error-openai-llm-failed')).toBe('Call ended');
    for (const label of Object.values(CLOSE_REASONS)) expect(label).not.toMatch(/_|-/);
  });

  it('reads the longest wait in seconds, one decimal', () => {
    expect(waitWords(1800)).toBe('1.8 s');
    expect(waitWords(2449)).toBe('2.4 s');
    expect(waitWords(0)).toBe('0.0 s');
  });
});
