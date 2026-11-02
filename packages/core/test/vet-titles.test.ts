import { describe, expect, it } from 'vitest';
import { bareName, hadTitle, providerFacts, providerName, RIVERBEND_CLINIC, titleOf } from '../src';

describe('"Dr." built in', () => {
  it('stores names without a typed title', () => {
    expect(['Dr. Elena Ruiz', 'dr elena ruiz', 'Doctor Elena Ruiz', 'Dra. Elena Ruiz', 'Mr Sam Lee', 'Ms. Kim Park', '  Elena Ruiz '].map(bareName))
      .toEqual(['Elena Ruiz', 'elena ruiz', 'Elena Ruiz', 'Elena Ruiz', 'Sam Lee', 'Kim Park', 'Elena Ruiz']);
    expect(bareName('Drake Bell')).toBe('Drake Bell'); // a name that only starts like a title
    expect(hadTitle('Dr. Elena Ruiz')).toBe(true);
    expect(hadTitle('Drake Bell')).toBe(false);
  });

  it('says Dr. for a person, Dra. for a woman in Spanish, nothing for a groomer or a room, and never twice', () => {
    const ruiz = { name: 'Elena Ruiz', gender: 'female', kind: 'person' as const };
    expect(providerName(ruiz)).toBe('Dr. Elena Ruiz');
    expect(providerName(ruiz, 'es')).toBe('Dra. Elena Ruiz');
    expect(providerName({ ...ruiz, gender: 'male' }, 'es')).toBe('Dr. Elena Ruiz');
    expect(providerName({ ...ruiz, gender: undefined }, 'es')).toBe('Dr. Elena Ruiz');
    expect(providerName({ ...ruiz, name: 'Dr. Elena Ruiz' })).toBe('Dr. Elena Ruiz'); // saved before the rule
    expect(providerName({ name: 'Pat Groomer', kind: 'person', title: 'none' })).toBe('Pat Groomer');
    expect(providerName({ name: 'the X-ray room', kind: 'room' })).toBe('the X-ray room');
    expect(titleOf({ kind: 'room', title: 'dr' })).toBe('none');
    expect(providerName({ name: 'our veterinarian', kind: 'person', placeholder: true })).toBe('our veterinarian');
  });

  it('gives the assistant the titled name, and never a vet\'s own phone', () => {
    const clinic = { ...RIVERBEND_CLINIC, providers: RIVERBEND_CLINIC.providers.map((p, i) => ({ ...p, name: p.name.replace(/^Dr\.\s+/, ''), phone: `+1720555019${i}`, otherPhones: [`+1720555018${i}`] })) };
    const facts = providerFacts(clinic, '2026-09-28', 'en');
    expect(facts.map((f) => f.name)).toContain('Dr. Elena Ruiz');
    const text = JSON.stringify(facts);
    expect(text).not.toMatch(/555019|555018/);
    expect(text).not.toMatch(/"phone"|"otherPhones"/);
  });
});
