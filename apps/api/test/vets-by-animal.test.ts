import { animalFit, ClinicConfig, DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { createPhiCipher, PostgresPatientDirectory, saveClinic } from '@attendra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { startApi } from './helpers';

// Note 2026-11-16 K1: New booking for a bird offered the dogs-and-cats vet first. The staff's open times follow the
// same rule as the assistant's find_slots (core animalFit), and say which vets see the pet so the vet list can mark the
// others. Monday 28 September 2026, 8 pm in Denver. Made-up vets and pets.
const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);
const C = `/api/v1/clinics/${DEMO_CLINIC.id}/appointments`;
const base = DEMO_CLINIC.providers[0]!;
const visits = DEMO_CLINIC.visitTypes.map((v) => v.id);
const clinic = (categories: { chen: string[]; lee: string[] }, booking?: object) => ClinicConfig.parse({
  ...DEMO_CLINIC, industry: 'vet', ...(booking ? { booking } : {}),
  providers: [
    { ...base, id: 'prov_chen', name: 'Dr. Avery Chen', categories: categories.chen, visitTypeIds: visits },
    { ...base, id: 'prov_lee', name: 'Dr. Robin Lee', categories: categories.lee, visitTypeIds: visits },
  ],
});
const MAPLE = { chen: ['Dog', 'Cat'], lee: ['Rabbit', 'Bird', 'Reptile', 'Guinea pig', 'Ferret'] };

let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
const pets: Record<string, string> = {};
const slots = async (patient: string, providerId?: string) =>
  (await api.request('GET', `${C}/slots?visitTypeId=vt_sick&from=2026-09-29&days=7&patientId=${pets[patient]}${providerId ? `&providerId=${providerId}` : ''}`, { cookie: staff })).json();
const vetsIn = (list: { slots: { providerId: string }[] }) => [...new Set(list.slots.map((s) => s.providerId))].sort();

beforeAll(async () => {
  api = await startApi({ demoMode: false, now: () => NOW });
  staff = await api.signIn('ana@maple.example', true);
  const directory = new PostgresPatientDirectory(api.t.db, createPhiCipher(TEST_DATA_KEY));
  for (const [name, species] of [['Kiwi', 'bird'], ['Rex', 'dog'], ['Dobby', 'horse'], ['Nameless', null]] as const) {
    pets[name] = await directory.create(DEMO_CLINIC.id, { firstName: name, lastName: 'Example', dob: '2022-04-01', phone: '+13035550181', guardianName: 'Sam Example', gender: 'female', species });
  }
});
afterAll(() => api.close());

describe('open times for a pet, by its kind of animal (K1)', () => {
  it('a bird: only the vet who sees birds, and the answer says so', async () => {
    await saveClinic(api.t.db, 'org_demo', clinic(MAPLE));
    const bird = await slots('Kiwi');
    expect(bird.slots.length).toBeGreaterThan(0);
    expect(vetsIn(bird)).toEqual(['prov_lee']);
    expect(bird.animal).toEqual({ kind: 'bird', seeIds: ['prov_lee'] });
    // the server's answer is core's rule, word for word
    expect(bird.animal).toEqual(animalFit(clinic(MAPLE), 'bird'));
  });

  it('a dog: only the vet who sees dogs', async () => {
    const dog = await slots('Rex');
    expect(vetsIn(dog)).toEqual(['prov_chen']);
    expect(dog.animal).toEqual({ kind: 'dog', seeIds: ['prov_chen'] });
  });

  it('a vet the desk names is theirs to choose: their times, with the same answer for the mark', async () => {
    const named = await slots('Kiwi', 'prov_chen');
    expect(vetsIn(named)).toEqual(['prov_chen']);
    expect(named.animal).toEqual({ kind: 'bird', seeIds: ['prov_lee'] });
  });

  it('as before when no vet lists the kind, no vet lists animals, the pet has no kind, or the rule is off', async () => {
    for (const name of ['Dobby', 'Nameless']) {
      const any = await slots(name);
      expect(any.animal, name).toBeNull();
      expect(vetsIn(any), name).toEqual(['prov_chen', 'prov_lee']);
    }
    await saveClinic(api.t.db, 'org_demo', clinic({ chen: [], lee: ['Dentistry'] }));
    expect(vetsIn(await slots('Kiwi'))).toEqual(['prov_chen', 'prov_lee']);
    // one vet lists dogs and cats, the other no animals: nobody lists birds, so everyone, as before
    await saveClinic(api.t.db, 'org_demo', clinic({ chen: ['Dog', 'Cat'], lee: [] }));
    const mixed = await slots('Kiwi');
    expect(mixed.animal).toBeNull();
    expect(vetsIn(mixed)).toEqual(['prov_chen', 'prov_lee']);
    await saveClinic(api.t.db, 'org_demo', clinic(MAPLE, { matchAnimal: false }));
    const off = await slots('Kiwi');
    expect(off.animal).toBeNull();
    expect(vetsIn(off)).toEqual(['prov_chen', 'prov_lee']);
  });

  it('no patient: every vet, nothing about animals', async () => {
    await saveClinic(api.t.db, 'org_demo', clinic(MAPLE));
    const none = (await api.request('GET', `${C}/slots?visitTypeId=vt_sick&from=2026-09-29&days=7`, { cookie: staff })).json();
    expect(vetsIn(none)).toEqual(['prov_chen', 'prov_lee']);
    expect(none.animal ?? null).toBeNull();
  });
});
