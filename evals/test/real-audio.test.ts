import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type CallResult, judgeWords, RealAudioFile, replyMs, report } from '../real-audio/harness';

describe('the real-audio harness (batch 1a)', () => {
  const file = RealAudioFile.parse(parse(readFileSync(join(__dirname, '../real-audio/scenarios.yaml'), 'utf8')));

  it('has ten calls in English and Spanish, each with its own id', () => {
    expect(file.scenarios).toHaveLength(10);
    expect(new Set(file.scenarios.map((s) => s.id)).size).toBe(10);
    expect(file.scenarios.filter((s) => s.language === 'es').length).toBeGreaterThanOrEqual(2);
  });

  it('counts filler, questions asked twice, and the phrases a call must and must never say', () => {
    const s = { ...file.scenarios[0]!, expect: { said: ['Biscuit', 'Thursday'], never: ['booked'] } };
    const words = judgeWords(s, ['Let me check.', 'Is this for Biscuit?', 'Is this for Biscuit?', 'All set, that\'s booked.']);
    expect(words).toEqual({ fillerLines: 1, repeatedQuestions: 1, missing: ['Thursday'], forbidden: ['booked'] });
  });

  it('reports the wait from the caller\'s last word to the first sound back, and the totals', () => {
    const call: CallResult = {
      scenario: 'book-known-pet', engine: 'gpt-realtime', callId: 'c1', firstAudioMs: 900, stalls: 0, fillerLines: 0, repeatedQuestions: 0, missing: [], forbidden: [], ended: 'caller',
      turns: [
        { caller: 'Hi', callerEndAt: 1000, heardAt: 1700, overlapped: false, agent: 'Sure.' },
        { caller: 'Biscuit', callerEndAt: 5000, heardAt: 6200, overlapped: true, agent: 'Found him.' },
        { caller: 'Hello?', callerEndAt: 9000, heardAt: null, overlapped: false, agent: '' },
      ],
    };
    expect(replyMs(call)).toEqual([700, 1200]);
    const md = report([call], { startedAt: new Date('2026-11-06T12:00:00Z'), base: 'http://localhost:3000', clinic: '/c/clinic_demo_riverbend', engine: 'gpt-realtime' });
    expect(md).toContain('| book-known-pet | 3 | 1200 / 1200 / 1200 | 900 | 0 | 0 | 0 | 1 | - | - | caller |');
    expect(md).toContain('reply ms median 1200, p90 1200 (n=2)');
  });
});
