import { describe, expect, it } from 'vitest';
import { ClinicConfig, DEMO_CLINIC, providerFacts, RIVERBEND_CLINIC } from '../src';

describe('what the assistant is told about a provider', () => {
  it('says which part of a day they are away, and never a whole day for a part', () => {
    const okafor = { ...DEMO_CLINIC.providers[0]!, timeOff: [{ from: '2026-10-22', to: '2026-10-22', start: '13:00', end: '18:00' }, { from: '2026-10-26', to: '2026-10-27' }] };
    const [facts] = providerFacts({ ...DEMO_CLINIC, providers: [okafor] }, '2026-10-20', 'en');
    expect(facts!.away).toEqual(['2026-10-22 13:00 to 18:00', '2026-10-26 to 2026-10-27']);
  });

  it('gives the clinic\'s own fields on a vet under their labels, and keeps a private one for the team', () => {
    const ruiz = { ...RIVERBEND_CLINIC.providers[0]!, custom: { quals: 'DVM, 12 years with small animals', langs: 'English | Spanish', licence: 'CO-55501', gone: 'old value', blank: '' } };
    const clinic = {
      ...RIVERBEND_CLINIC, providers: [ruiz],
      providerFields: [
        { id: 'quals', label: 'Qualifications', kind: 'text' as const },
        { id: 'langs', label: 'Languages', kind: 'multi' as const, options: ['English', 'Spanish'], tellCallers: true },
        { id: 'licence', label: 'Licence number', kind: 'text' as const, tellCallers: false },
        { id: 'blank', label: 'Hobbies', kind: 'text' as const },
      ],
    };
    const [facts] = providerFacts(clinic, '2026-10-20', 'en');
    expect(facts!.details).toEqual({ Qualifications: 'DVM, 12 years with small animals', Languages: 'English, Spanish' });
    expect(JSON.stringify(facts)).not.toContain('CO-55501');
    // a field the clinic removed is not told, and a vet with nothing filled in has no details at all
    expect(JSON.stringify(facts)).not.toContain('old value');
    expect(providerFacts({ ...clinic, providers: [RIVERBEND_CLINIC.providers[1]!] }, '2026-10-20', 'en')[0]).not.toHaveProperty('details');
  });

  it('loads a field saved before the switch existed as one callers may hear', () => {
    const c = ClinicConfig.parse({ ...RIVERBEND_CLINIC, providerFields: [{ id: 'quals', label: 'Qualifications', kind: 'text' }] });
    expect(c.providerFields![0]!.tellCallers).toBeUndefined();
    expect(providerFacts({ ...c, providers: [{ ...c.providers[0]!, custom: { quals: 'DVM' } }] }, '2026-10-20', 'en')[0]!.details).toEqual({ Qualifications: 'DVM' });
  });
});
