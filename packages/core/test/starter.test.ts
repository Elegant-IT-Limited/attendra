import { describe, expect, it } from 'vitest';
import { ClinicConfig, managedList, notOnListProblem, starterClinic } from '../src';

describe('a new clinic\'s first settings', () => {
  it('are valid, disclose the assistant, and follow the pack', () => {
    const vet = starterClinic({ id: 'clinic_new', name: 'Oak Hill Vets', timezone: 'America/Chicago', industry: 'vet', phone: '+13125550100' });
    // the animals list exists before the first vet does, so a picker can offer Dogs and the API accepts it (2026-11-01)
    expect(managedList(vet, 'categories')).toEqual(['Dogs', 'Cats', 'Rabbits', 'Birds', 'Reptiles', 'Small mammals', 'Exotic pets']);
    expect(notOnListProblem(vet, 'categories', ['Dogs', 'Cats'])).toBeNull();
    expect(vet.averageVisitValue).toBeUndefined();
    expect(ClinicConfig.safeParse(vet).success).toBe(true);
    expect(vet.greeting).toContain('Oak Hill Vets');
    expect(vet.afterHours).toBe('requests');
    expect(vet.visitTypes.map((v) => v.name)).toContain('new client exam');
    expect(vet.providers[0]!.visitTypeIds).toEqual(vet.visitTypes.map((v) => v.id));
    expect(vet.faqs).toEqual([]);
    const clinic = starterClinic({ id: 'clinic_med', name: 'Elm Family Practice', timezone: 'America/New_York', industry: 'clinic', phone: '+12125550100' });
    expect(clinic.afterHours).toBe('book');
    expect(clinic.visitTypes.map((v) => v.name)).toContain('new patient visit');
  });

  it('refuses what would not load later: a bad time zone or number', () => {
    expect(() => starterClinic({ id: 'c', name: 'X', timezone: 'Mars/Base', industry: 'vet', phone: '+13125550100' })).toThrow();
    expect(() => starterClinic({ id: 'c', name: 'X', timezone: 'America/Chicago', industry: 'vet', phone: '3125550100' })).toThrow();
  });
});
