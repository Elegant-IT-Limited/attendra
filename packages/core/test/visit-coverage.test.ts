import { describe, expect, it } from 'vitest';
import { allVisitTypeIds, ClinicConfig, DEMO_CLINIC, doesEveryVisitType, noProviderWarnings, readDoctors, starterClinic, visitTypeCoverage, visitTypesWithNoProvider } from '../src';

// a made-up vet clinic: three visit types, two vets, nobody does dental care
const vets = ClinicConfig.parse({
  ...starterClinic({ id: 'clinic_types', name: 'Willow Lane Vets', timezone: 'America/Denver', industry: 'vet', phone: '+13035550160' }),
  visitTypes: [
    { id: 'vt_exam', name: 'Wellness exam', names: { es: 'Revisión general' }, minutes: 20 },
    { id: 'vt_dental', name: 'Dental care', names: { es: 'Cuidado dental' }, minutes: 40 },
    { id: 'vt_surgery', name: 'Surgery consultation', minutes: 30 },
  ],
  providers: [
    { id: 'prov_one', name: 'Iris Vale', gender: 'female', visitTypeIds: ['vt_exam', 'vt_surgery'] },
    { id: 'prov_two', name: 'Omar Hale', gender: 'male', visitTypeIds: ['vt_exam'] },
  ],
});

describe('who does which visit type', () => {
  it('a new vet starts with every visit type the clinic has', () => {
    expect(allVisitTypeIds(vets)).toEqual(['vt_exam', 'vt_dental', 'vt_surgery']);
    expect(doesEveryVisitType({ visitTypeIds: allVisitTypeIds(vets) }, vets)).toBe(true);
    expect(doesEveryVisitType(vets.providers[0]!, vets)).toBe(false);
  });

  it('counts the vets per visit type and finds the types nobody does', () => {
    expect(visitTypeCoverage(vets).map((c) => [c.visitType.id, c.providers])).toEqual([['vt_exam', 2], ['vt_dental', 0], ['vt_surgery', 1]]);
    expect(visitTypesWithNoProvider(vets).map((v) => v.id)).toEqual(['vt_dental']);
    expect(visitTypesWithNoProvider(DEMO_CLINIC)).toEqual([]);
  });

  it('counts the stand-in only while nobody else is listed, and leaves out a new row with no name yet', () => {
    const fresh = starterClinic({ id: 'clinic_fresh', name: 'Fresh Vets', timezone: 'America/Denver', industry: 'vet', phone: '+13035550161' });
    expect(visitTypesWithNoProvider(fresh)).toEqual([]);
    const withStandIn = { ...vets, providers: [...vets.providers, { ...fresh.providers[0]!, visitTypeIds: ['vt_dental'] }] };
    expect(visitTypesWithNoProvider(withStandIn).map((v) => v.id)).toEqual(['vt_dental']);
    expect(visitTypesWithNoProvider({ ...vets, visitTypes: [...vets.visitTypes, { id: 'vt_new', name: ' ', minutes: 20, audience: 'all' }] }).map((v) => v.id)).toEqual(['vt_dental']);
  });

  it('warns in plain words, a vet at a vet clinic and a doctor elsewhere, in English and Spanish', () => {
    expect(noProviderWarnings(vets)).toEqual([{ visitTypeId: 'vt_dental', message: 'No vet does Dental care: callers can\'t book it' }]);
    expect(noProviderWarnings(vets, 'es')).toEqual([{ visitTypeId: 'vt_dental', message: 'Ningún veterinario ofrece Cuidado dental: quienes llaman no pueden reservarlo' }]);
    const people = { ...DEMO_CLINIC, providers: DEMO_CLINIC.providers.map((p) => ({ ...p, visitTypeIds: p.visitTypeIds.filter((id) => id !== 'vt_new') })) };
    expect(noProviderWarnings(people).map((w) => w.message)).toEqual(['No doctor does new patient visit: callers can\'t book it']);
    expect(noProviderWarnings(people, 'es').map((w) => w.message)).toEqual(['Ningún médico ofrece primera consulta: quienes llaman no pueden reservarlo']);
  });
});

describe('importing vets and visit types', () => {
  it('gives every visit type to a new vet when the file has no visit types column', () => {
    const rows = readDoctors('name,gender,phone\nTessa Brook,female,(303) 555-0171\n', vets);
    expect(rows[0]).toMatchObject({ ok: true, value: { visitTypeIds: ['vt_exam', 'vt_dental', 'vt_surgery'] } });
  });

  it('keeps what a vet on file does when the file has no visit types column', () => {
    const rows = readDoctors('name,gender,phone\nOmar Hale,male,(303) 555-0172\n', vets);
    expect(rows[0]).toMatchObject({ ok: true, existingId: 'prov_two', value: { visitTypeIds: ['vt_exam'] } });
  });

  it('reads "all" as every visit type, and the names it lists as only those', () => {
    const rows = readDoctors('name,gender,phone,visit_types\nTessa Brook,female,(303) 555-0171,All visit types\nPia Lund,female,(303) 555-0173,dental care; wellness exam\n', vets);
    expect(rows.map((r) => r.ok && r.value.visitTypeIds)).toEqual([['vt_exam', 'vt_dental', 'vt_surgery'], ['vt_dental', 'vt_exam']]);
  });
});
