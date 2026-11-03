import { describe, expect, it } from 'vitest';
import { bySubject, detectEmergencies, industryPack, isPetEmergency } from '../src';

// Who a red flag is about at a clinic for animals (2026-11-15): "My dog Luna's throat is swelling" got the 911 line
// (Vetra, 2026-11-03). The person list fires the emergency number's script only when a person is the subject.
const vet = industryPack('vet').emergency!;
const judged = (text: string, pets: string[] = []) => bySubject(detectEmergencies(text, vet.phrases), text, vet.subjects!, pets);
/** 'pet' when the call gets the animal's script (a pet kind leads), 'person' when the emergency number's. */
const script = (text: string, pets: string[] = []) => {
  const found = judged(text, pets).filter((m) => m.kind !== 'general');
  if (!found.length) return null;
  return found.some((m) => m.kind === 'self_harm') ? 'person' : found.some((m) => isPetEmergency(m.kind)) ? 'pet' : 'person';
};

describe('who a red flag is about', () => {
  it.each([
    "My dog Luna's throat is swelling",
    'my dog\'s throat is swelling up',
    'the cat\'s tongue is swelling',
    "I'm calling about my dog, he can't breathe",
    'our puppy is choking',
    "Luna's throat is swelling",
    'she has chest pain, my dog I mean, she is panting hard',
    'A mi perra Luna se le está hinchando la garganta',
    'mi gato no puede respirar',
    'a mi perro le cuesta respirar',
  ])('an animal: "%s" gets the pet script', (said) => {
    expect(script(said, ['Luna'])).toBe('pet');
  });

  it.each([
    "I can't breathe",
    'my throat is swelling',
    "I'm having chest pain",
    "Sorry, I'm calling about my cat but I've got chest pain right now and my arm is numb.",
    "my husband can't breathe",
    'my dog is fine but my son is choking',
    'my wife passed out',
    'No puedo respirar',
    'se me está cerrando la garganta',
    'a mi esposo le duele el pecho',
    'mi hija no puede respirar',
  ])('a person: "%s" gets the emergency number', (said) => {
    expect(script(said, ['Luna'])).toBe('person');
  });

  it('a pronoun is whoever was named last: "my husband, he can\'t breathe" is a person, "my dog, he can\'t breathe" a pet', () => {
    expect(script("it's my husband, he can't breathe")).toBe('person');
    expect(script("it's my dog, he can't breathe")).toBe('pet');
    // a pet's name on the call counts like "my dog"
    expect(script("it's Biscuit, he's not breathing", ['Biscuit'])).toBe('pet');
  });

  it('nobody named is the animal\'s: its script also tells a person in danger to call the emergency number', () => {
    expect(script('chest pain, hard to breathe')).toBe('pet');
  });

  it('turns a person\'s red flag about a pet into the animal\'s kind, and drops an animal\'s phrase the caller says of themselves', () => {
    expect(judged("my dog's throat is swelling").map((m) => m.kind)).toEqual(['pet_breathing']);
    expect(judged("I can't breathe").map((m) => m.kind)).toEqual(['breathing']);
    expect(judged("my husband can't breathe").map((m) => m.kind)).toEqual(['breathing']);
  });

  it('never moves self-harm or the bare word', () => {
    expect(judged('my dog died and I want to kill myself').map((m) => m.kind)).toContain('self_harm');
    expect(judged('this is an emergency').map((m) => m.kind)).toEqual(['general']);
  });

  it('"bitten by a dog" is not about the dog', () => {
    expect(script('my son was bitten by a dog and is bleeding a lot')).toBe('person');
  });
});
