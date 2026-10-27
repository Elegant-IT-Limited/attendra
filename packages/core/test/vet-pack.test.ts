import { describe, expect, it } from 'vitest';
import { detectEmergencies, industryPack, isPetEmergency, parsePetBirth, RIVERBEND_CLINIC, toolArgsFor } from '../src';

const vet = industryPack('vet');
const phrases = vet.emergency!.phrases;
const petKinds = (text: string) => detectEmergencies(text, phrases).filter((m) => isPetEmergency(m.kind)).map((m) => m.kind);

describe('the veterinary pack', () => {
  it('finds a pet by its owner and its own name, and takes the kind of animal and its age to add one', () => {
    expect(vet.identity).toBe('pet');
    const args = toolArgsFor('vet');
    expect(args.verify_caller.safeParse({ owner_name: 'Linh Nguyen', pet_name: 'Biscuit' }).success).toBe(true);
    // the owner's name is not needed to find a pet: the number and the pet's name are (2026-11)
    expect(args.verify_caller.safeParse({ owner_name: null, pet_name: 'Biscuit', phone: '720 555 0172' }).success).toBe(true);
    expect(args.verify_caller.parse({})).toMatchObject({ owner_name: null, pet_name: null, phone: null });
    expect(args.verify_caller.safeParse({ owner_name: 'L', pet_name: 'Biscuit' }).success).toBe(false);
    expect(args.register_patient.safeParse({ pet_name: 'Ziggy', owner_name: 'Ava Patel', species: 'dog', sex: 'male', birthday_or_age: '8 months' }).success).toBe(true);
    // the clinic's tools are unchanged
    expect(toolArgsFor('clinic').verify_caller.safeParse({ full_name: 'Maria Delgado', date_of_birth: 'March 4 1985' }).success).toBe(true);
  });

  it.each([
    ['pet_toxin', 'my dog just ate a whole bar of dark chocolate'],
    ['pet_toxin', 'she got into the rat poison in the garage'],
    ['pet_toxin', 'I think he licked some antifreeze'],
    ['pet_toxin', 'he swallowed a sock this morning'],
    ['pet_toxin', 'our puppy chewed up a pack of sugar free gum'],
    ['pet_breathing', "my cat can't breathe"],
    ['pet_breathing', 'his gums are blue'],
    ['pet_breathing', 'she is open mouth breathing'],
    ['pet_trauma', 'my dog was hit by a car'],
    ['pet_trauma', "he's bleeding a lot from his paw"],
    ['pet_trauma', 'she was bitten by a snake'],
    ['pet_collapse', 'he collapsed in the yard'],
    ['pet_collapse', "she's having a seizure"],
    ['pet_collapse', 'I think my cat is dying'],
    ['pet_bloat', "his belly is swollen and hard and he's retching"],
    ['pet_bloat', 'he keeps trying to throw up but nothing comes out'],
    ['pet_urinary', "my cat can't pee"],
    ['pet_urinary', 'he keeps straining to urinate'],
    ['pet_heat', 'I think she has heatstroke'],
    ['pet_birth', "she's been in labour for hours"],
    ['pet_birth', 'a puppy is stuck'],
  ])('%s: "%s"', (kind, text) => {
    expect(petKinds(text)).toContain(kind);
  });

  it.each([
    ['pet_toxin', 'mi perro se comió una barra de chocolate'],
    ['pet_toxin', 'creo que tomó anticongelante'],
    ['pet_breathing', 'mi gata no puede respirar'],
    ['pet_trauma', 'a mi perro lo atropelló un carro'],
    ['pet_collapse', 'está convulsionando'],
    ['pet_bloat', 'tiene la panza hinchada y quiere vomitar y no puede'],
    ['pet_urinary', 'mi gato no puede orinar'],
    ['pet_heat', 'creo que le dio un golpe de calor'],
    ['pet_birth', 'hay un cachorro atorado'],
  ])('%s in Spanish: "%s"', (kind, text) => {
    expect(petKinds(text)).toContain(kind);
  });

  it('lets an ordinary call to a vet through', () => {
    for (const t of [
      "I'd like to book a check-up for Biscuit", 'is she due for her vaccines', 'my chocolate lab needs his nails trimmed',
      'he ate his dinner fine', 'can I pick up more of her food', 'do you see rabbits', 'quisiera una cita para mi perro',
    ]) expect(petKinds(t), t).toEqual([]);
  });

  it('sends an animal in danger to the clinic\'s emergency hospital, and a person in danger to the emergency number', () => {
    const script = vet.emergency!.script('en', { hospital: RIVERBEND_CLINIC.emergencyHospital!, emergencyNumber: '911' });
    expect(script).toContain('Front Range Pet Emergency at 1200 Larkspur Avenue, Denver');
    expect(script).toContain('If a person is hurt or in danger, call 911.');
    expect(script).toMatch(/do not give medical or first-aid advice/i);
    expect(vet.emergency!.script('es', { hospital: null, emergencyNumber: '911' })).toContain('hospital veterinario de emergencias de 24 horas más cercano');
  });
});

describe('a pet\'s age or birthday', () => {
  const today = new Date('2026-10-16T12:00:00Z');
  it.each([
    ['March 4 2021', '2021-03-04', false],
    ['3 years old', '2023-10-16', true],
    ['about two', '2024-10-16', true],
    ['six months', '2026-04-16', true],
    ['8 weeks', '2026-08-21', true],
    ['tres años', '2023-10-16', true],
    // as callers say a date: spoken ordinals, "the", "of"
    ['fifteenth January 2026', '2026-01-15', false],
    ['the 5th of January 2026', '2026-01-05', false],
    ['January twenty-first, 2025', '2025-01-21', false],
    // with the words around it, as an owner says it (live run 8 asked the age again)
    ['she was born on the fifteenth of January 2026', '2026-01-15', false],
    ['15th of January this year', '2026-01-15', false],
    ['she is about two', '2024-10-16', true],
    ['a year and a half', '2025-04-16', true],
    ['January 2026', '2026-01-15', true],
    ['last January', '2026-01-15', true],
    // whole sentences, punctuation and all (live run 8b still asked the age again)
    ['Her birthday is January 15, 2026.', '2026-01-15', false],
    ['She was born on the fifteenth of January 2026.', '2026-01-15', false],
    ["He's a rescue, so I'm not sure. About two?", '2024-10-16', true],
    ["I'm not sure, about two", '2024-10-16', true],
    ['Maybe two or three', '2024-10-16', true],
    ["He's two.", '2024-10-16', true],
  ])('"%s" is %s', (said, dob, estimated) => {
    expect(parsePetBirth(said, today)).toEqual({ dob, estimated });
  });

  it('refuses what is neither a date nor an age', () => {
    for (const t of ['no idea', 'old', '45 years', 'fifth Jan', 'a rescue', 'she is new', 'I have a dog', 'January 15th.']) expect(parsePetBirth(t, today), t).toBeNull();
  });
});
