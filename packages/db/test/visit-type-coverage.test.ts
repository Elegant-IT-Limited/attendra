import { ClinicConfig, starterClinic } from '@attendra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coverageOf, createOrganizationWithClinic, formatVisitTypeCoverage, visitTypeCoverageReport } from '../src';
import { openTestDatabase } from '../src/testing';

const C = 'clinic_type_vets';
let t: Awaited<ReturnType<typeof openTestDatabase>>;

// made-up vets and visit types; none of these names may reach the printout
const NAMES = ['Iris Vale', 'Omar Hale', 'Tessa Brook', 'Wellness exam', 'Dental care', 'Surgery consultation', 'vt_exam', 'vt_dental', 'vt_surgery', 'prov_'];
const config = ClinicConfig.parse({
  ...starterClinic({ id: C, name: 'Type Check Vets', timezone: 'America/Denver', industry: 'vet', phone: '+13035550180' }),
  visitTypes: [
    { id: 'vt_exam', name: 'Wellness exam', minutes: 20 },
    { id: 'vt_dental', name: 'Dental care', minutes: 40 },
    { id: 'vt_surgery', name: 'Surgery consultation', minutes: 30 },
  ],
  providers: [
    { id: 'prov_iris', name: 'Iris Vale', gender: 'female', phone: '+13035550181', visitTypeIds: ['vt_exam', 'vt_surgery'] },
    { id: 'prov_omar', name: 'Omar Hale', gender: 'male', phone: '+13035550182', visitTypeIds: ['vt_exam'] },
    { id: 'prov_tessa', name: 'Tessa Brook', gender: 'female', phone: '+13035550183', visitTypeIds: ['vt_exam'] },
  ],
});

beforeAll(async () => {
  t = await openTestDatabase();
  await createOrganizationWithClinic(t.db, { id: 'org_type_vets', name: 'Type Check Vets', plan: 'trial' }, config);
});
afterAll(() => t.close());

describe('the visit-type coverage dry run', () => {
  it('counts the vets per visit type, in Settings order, and finds the types nobody does', async () => {
    expect(coverageOf(C, config)).toEqual({ clinicId: C, industry: 'vet', vets: 3, perType: [3, 0, 1], noVet: [2] });
    const r = await visitTypeCoverageReport(t.db);
    expect(r.clinics.find((c) => c.clinicId === C)).toEqual({ clinicId: C, industry: 'vet', vets: 3, perType: [3, 0, 1], noVet: [2] });
    expect(r.unreadable).toBe(0);
  });

  it('counts the stand-in a new clinic starts with only while nobody else is listed', () => {
    const fresh = starterClinic({ id: 'clinic_fresh_types', name: 'Fresh Vets', timezone: 'America/Denver', industry: 'vet', phone: '+13035550184' });
    expect(coverageOf(fresh.id, fresh).noVet).toEqual([]);
    expect(coverageOf(C, { ...config, providers: [...config.providers, { ...fresh.providers[0]!, visitTypeIds: ['vt_dental'] }] }).noVet).toEqual([2]);
  });

  it('prints clinic ids and counts only: no vet, no visit type name or id', async () => {
    const out = formatVisitTypeCoverage(await visitTypeCoverageReport(t.db)).join('\n');
    expect(out).toContain(`clinic ${C} · vet · vets 3 · visit types 3 · vets per type #1=3 #2=0 #3=1 · no vet for 1: #2`);
    expect(out).toMatch(/visit-type coverage: \d+ of \d+ clinics have a type no vet does \(\d+ types\) \(dry run, nothing written\)$/);
    for (const name of NAMES) expect(out).not.toContain(name);
  });
});
