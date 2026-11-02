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
    expect(vet.visitTypes.map((v) => [v.name, v.minutes])).toEqual([['check-up', 20], ['sick visit', 30], ['vaccines', 15], ['new patient visit', 40]]);
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

describe('visit types the team books', () => {
  it('names the related visit a caller can book, says the notice in days or hours, and spots a notice longer than the furthest date', async () => {
    const { relatedBookable, noticeWords, noDayPossible, configProblems, PACKS } = await import('../src');
    const types = [
      { id: 'vt_surgery', name: 'Surgical services', minutes: 60, audience: 'all' as const, staffOnly: true, noticeHours: 25 },
      { id: 'vt_consult', name: 'surgery consultation', minutes: 30, audience: 'all' as const },
      { id: 'vt_sick', name: 'sick visit', minutes: 30, audience: 'all' as const },
    ];
    expect(relatedBookable({ visitTypes: types }, types[0]!)?.id).toBe('vt_consult');
    expect(relatedBookable({ visitTypes: types }, { id: 'vt_x', name: 'Grooming' })).toBeNull();
    expect([noticeWords(25), noticeWords(72), noticeWords(24), noticeWords(1)]).toEqual(['25 hours', '3 days', '1 day', '1 hour']);
    expect(PACKS.en.teamBooks({ visit: 'Surgical services', notice: '25 hours', related: 'surgery consultation' }))
      .toBe("Our team books surgical services themselves, with at least 25 hours' notice. I can take a request for the team, or book a surgery consultation first. Which would you like?");
    expect(PACKS.es.teamBooks({ visit: 'Cirugía', notice: '3 days', related: 'consulta de cirugía' }))
      .toBe('Nuestro equipo reserva cirugía directamente, con al menos 3 días de anticipación. Puedo dejarle una solicitud al equipo, o reservarle primero consulta de cirugía. ¿Qué prefiere?');
    expect(noDayPossible({ noticeHours: 96, maxDaysAhead: 3 })).toBe(true);
    expect(noDayPossible({ noticeHours: 72, maxDaysAhead: 3 })).toBe(false);
    expect(configProblems({ providers: [], visitTypes: [{ ...types[1]!, noticeHours: 96, maxDaysAhead: 3 }] })).toEqual([{ path: 'visitTypes.0.noticeHours', message: 'surgery consultation: the notice is longer than the furthest date, so no day can be booked' }]);
  });
});
