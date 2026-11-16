import { describe, expect, it } from 'vitest';
import { animalFit, animalsWord, bookingOf, ClinicConfig, DEMO_CLINIC, findSlots, listsAnimals, RIVERBEND_CLINIC, seesAnimal, speakSlot, usualProviderOf, zonedInstant } from '../src';

const tz = DEMO_CLINIC.timezone;
const now = zonedInstant('2026-09-28', '20:00', tz);
const sick = DEMO_CLINIC.visitTypes.find((v) => v.id === 'vt_sick')!;

describe('the booking rules', () => {
  it('default to the usual vet first within 3 days, the fewest visits on a tie, and matching the animal', () => {
    expect(bookingOf({})).toEqual({ noPreference: 'usual_first', usualWithinDays: 3, tieBreak: 'fewest_visits', matchAnimal: true, startEvery: 10 });
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

describe('the vets a pet may be offered for its kind of animal (note 2026-11-16 K1)', () => {
  const vets = (providers: { id: string; categories: string[] }[], booking?: object) => ClinicConfig.parse({
    ...RIVERBEND_CLINIC, ...(booking ? { booking } : {}),
    providers: providers.map((p) => ({ ...RIVERBEND_CLINIC.providers[0]!, id: p.id, name: `Dr. ${p.id}`, categories: p.categories })),
  });
  const maple = vets([{ id: 'chen', categories: ['Dog', 'Cat'] }, { id: 'lee', categories: ['Rabbit', 'Bird', 'Reptile', 'Guinea pig', 'Ferret'] }]);

  it('only the vets who see it when some do: a bird to the exotics vet, a dog to the dogs-and-cats vet', () => {
    expect(animalFit(maple, 'bird')).toEqual({ kind: 'bird', seeIds: ['lee'] });
    expect(animalFit(maple, 'Bird')).toEqual({ kind: 'bird', seeIds: ['lee'] });
    expect(animalFit(maple, 'dog')).toEqual({ kind: 'dog', seeIds: ['chen'] });
    expect(animalFit(maple, 'guinea pig')).toEqual({ kind: 'guinea pig', seeIds: ['lee'] });
    // a parrot is a bird, a puppy a dog, in Spanish too
    expect(animalFit(maple, 'parrot')?.seeIds).toEqual(['lee']);
    expect(animalFit(maple, 'perro')?.seeIds).toEqual(['chen']);
  });

  it('a vet who lists no animals sees them all, as the booking rules say', () => {
    const mixed = vets([{ id: 'chen', categories: ['Dog', 'Cat'] }, { id: 'lee', categories: ['Bird'] }, { id: 'gray', categories: ['Dentistry'] }]);
    expect(animalFit(mixed, 'bird')?.seeIds).toEqual(['lee', 'gray']);
  });

  it('nothing narrows when no vet lists the kind, no vet lists animals, the pet has no kind, or the rule is off', () => {
    expect(animalFit(maple, 'horse')).toBeNull();
    expect(animalFit(vets([{ id: 'a', categories: [] }, { id: 'b', categories: ['Dentistry'] }]), 'bird')).toBeNull();
    expect(animalFit(maple, null)).toBeNull();
    expect(animalFit(maple, '  ')).toBeNull();
    expect(animalFit(vets([{ id: 'chen', categories: ['Dog', 'Cat'] }, { id: 'lee', categories: ['Bird'] }], { matchAnimal: false }), 'bird')).toBeNull();
  });

  it('says the kind for many, as the desk reads it', () => {
    expect(['bird', 'Dog', 'guinea pig', 'fish', 'ferret', 'canary', 'mouse', 'box turtle', 'finch'].map(animalsWord))
      .toEqual(['birds', 'dogs', 'guinea pigs', 'fish', 'ferrets', 'canaries', 'mice', 'box turtles', 'finches']);
  });
});
