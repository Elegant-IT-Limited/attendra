import { RIVERBEND_CLINIC } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { providerNamed, specialtyIsTheVisit } from '../src/tools';

// Batch 1c: find_slots takes a vet the way the caller says it; a live run lost a model round on "Dr. Khan" each time.
const vets = RIVERBEND_CLINIC.providers;

describe('providerNamed', () => {
  it('finds the one vet a spoken name fits, titles and accents aside, EN and ES', () => {
    expect(providerNamed(vets, 'Dr. Ruiz')?.id).toBe('prov_ruiz');
    expect(providerNamed(vets, 'Ruiz')?.id).toBe('prov_ruiz');
    expect(providerNamed(vets, 'la doctora Elena Ruiz')?.id).toBe('prov_ruiz');
    expect(providerNamed(vets, 'Dra. Sató')?.id).toBe('prov_sato');
    expect(providerNamed(vets, 'Hana')?.id).toBe('prov_sato');
  });

  it('is null for a name nobody has, or one several share, or only a title', () => {
    expect(providerNamed(vets, 'Dr. Smith')).toBeNull();
    expect(providerNamed(vets, 'Dr.')).toBeNull();
    expect(providerNamed([...vets, { ...vets[0]!, id: 'prov_ruiz_2', name: 'Dr. Tomas Ruiz' }], 'Dr. Ruiz')).toBeNull();
  });
});

describe('specialtyIsTheVisit: a "specialty" that narrows nothing (batch 1c)', () => {
  const clinic = { visitTypes: [...RIVERBEND_CLINIC.visitTypes, { id: 'vt_dental', name: 'dental care', names: { es: 'cuidado dental' }, minutes: 30, audience: 'all' as const }] };
  it('is the visit type itself, in either language, or no specialty at all', () => {
    for (const said of ['dental care', 'Dental', 'cuidado dental', 'General practice', 'medicina general', 'sick visit', 'dog', 'perro']) expect(specialtyIsTheVisit(said, clinic)).toBe(true);
  });
  it('is a real specialty when it names none of the visits', () => {
    for (const said of ['Cardiology', 'exotics', 'Dermatología']) expect(specialtyIsTheVisit(said, clinic)).toBe(false);
  });
});
