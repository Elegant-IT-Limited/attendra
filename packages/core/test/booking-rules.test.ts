import { describe, expect, it } from 'vitest';
import { bookingOf, DEMO_CLINIC, findSlots, listsAnimals, seesAnimal, speakSlot, usualProviderOf, zonedInstant } from '../src';

const tz = DEMO_CLINIC.timezone;
const now = zonedInstant('2026-09-28', '20:00', tz);
const sick = DEMO_CLINIC.visitTypes.find((v) => v.id === 'vt_sick')!;

describe('the booking rules', () => {
  it('default to the usual vet first within 3 days, the fewest visits on a tie, and matching the animal', () => {
    expect(bookingOf({})).toEqual({ noPreference: 'usual_first', usualWithinDays: 3, tieBreak: 'fewest_visits', matchAnimal: true });
  });

  it('take the usual one as the most visits in two years, the latest breaking a tie, never a cancelled or future one', () => {
    const at = (d: string) => zonedInstant(d, '10:00', tz);
    expect(usualProviderOf([{ providerId: 'a', start: at('2026-01-05') }, { providerId: 'b', start: at('2026-03-05') }, { providerId: 'a', start: at('2026-05-05') }], now)).toBe('a');
    expect(usualProviderOf([{ providerId: 'a', start: at('2026-01-05') }, { providerId: 'b', start: at('2026-03-05') }], now)).toBe('b');
    expect(usualProviderOf([{ providerId: 'a', start: at('2026-03-05'), status: 'cancelled' }, { providerId: 'b', start: at('2026-10-05') }], now)).toBeNull();
    expect(usualProviderOf([{ providerId: 'a', start: at('2023-01-05') }], now)).toBeNull(); // over two years ago
  });

  it('match a pet to vets who list its kind of animal, and let a vet who lists no animals see them all', () => {
    const exotics = { categories: ['Exotics', 'Dentistry'] };
    const dogsCats = { categories: ['Dogs', 'Cats'] };
    const services = { categories: ['Dentistry', 'Surgery'] };
    expect(listsAnimals(services)).toBe(false);
    expect(seesAnimal(services, 'rabbit')).toBe(true);
    expect(seesAnimal(exotics, 'rabbit')).toBe(true);
    expect(seesAnimal(exotics, 'dog')).toBe(false);
    expect(seesAnimal(dogsCats, 'dog')).toBe(true);
    expect(seesAnimal(dogsCats, 'Cat')).toBe(true);
    expect(seesAnimal(dogsCats, 'parrot')).toBe(false);
    expect(seesAnimal({ categories: ['Canine', 'Feline'] }, 'dog')).toBe(true);
    expect(seesAnimal({ categories: ['Birds'] }, 'parrot')).toBe(true);
  });

  it('offer three different times, each with whoever has the fewest visits that day', () => {
    const two = DEMO_CLINIC.providers.filter((p) => p.id !== 'prov_raman').map((p) => ({ ...p, hours: undefined }));
    // Dr. Okafor already has two visits on Tuesday; Dr. Lindqvist none
    const busy = [
      { providerId: 'prov_okafor', start: zonedInstant('2026-09-29', '15:00', tz), end: zonedInstant('2026-09-29', '15:20', tz) },
      { providerId: 'prov_okafor', start: zonedInstant('2026-09-29', '16:00', tz), end: zonedInstant('2026-09-29', '16:20', tz) },
    ];
    const slots = findSlots(DEMO_CLINIC, busy, { visitType: sick, providers: two, from: '2026-09-29', days: 1, now, distinctTimes: true, tieBreak: 'fewest' });
    expect(slots.map((s) => `${s.providerId} ${speakSlot(s.start, tz).replace(/^.* at /, '')}`)).toEqual(['prov_lindqvist 8:00 AM', 'prov_lindqvist 8:20 AM', 'prov_lindqvist 8:40 AM']);
    // without the rule: the list's order, and the same time twice
    const plain = findSlots(DEMO_CLINIC, busy, { visitType: sick, providers: two, from: '2026-09-29', days: 1, now });
    expect(plain.map((s) => s.providerId)).toEqual(['prov_okafor', 'prov_lindqvist', 'prov_okafor']);
  });
});
