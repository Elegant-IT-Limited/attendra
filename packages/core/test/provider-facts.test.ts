import { describe, expect, it } from 'vitest';
import { DEMO_CLINIC, providerFacts } from '../src';

describe('what the assistant is told about a provider', () => {
  it('says which part of a day they are away, and never a whole day for a part', () => {
    const okafor = { ...DEMO_CLINIC.providers[0]!, timeOff: [{ from: '2026-10-22', to: '2026-10-22', start: '13:00', end: '18:00' }, { from: '2026-10-26', to: '2026-10-27' }] };
    const [facts] = providerFacts({ ...DEMO_CLINIC, providers: [okafor] }, '2026-10-20', 'en');
    expect(facts!.away).toEqual(['2026-10-22 13:00 to 18:00', '2026-10-26 to 2026-10-27']);
  });
});
