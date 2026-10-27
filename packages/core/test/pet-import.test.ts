import { describe, expect, it } from 'vitest';
import { petTemplate, readPets } from '../src';

describe('importing pets', () => {
  it('reads the template as pets stored the way the assistant stores them', () => {
    const rows = readPets(petTemplate(), '2026-10-18');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ ok: true, value: { firstName: 'Biscuit', lastName: 'Rivera', guardianName: 'Jordan Rivera', species: 'dog', gender: 'female', dob: '2021-05-14' } });
    expect(rows[1]).toMatchObject({ ok: true, value: { firstName: 'Mochi', species: 'cat', gender: 'undisclosed' } });
    // an owner who goes by one name: no last name, and the pet is named by itself
    expect(rows[2]).toMatchObject({ ok: true, name: 'Pepper (Sol)', value: { firstName: 'Pepper', lastName: '', guardianName: 'Sol' } });
  });

  it('still reads the older file with one owner_name column, one name or more', () => {
    const csv = 'pet_name,species,birthday,owner_name,owner_phone\nRex,dog,2020-01-01,Ana Maria Ruiz,3035550100\nMia,cat,2020-01-01,Sol,3035550101\n';
    expect(readPets(csv, '2026-10-18').map((r) => r.ok && [r.value.guardianName, r.value.lastName])).toEqual([['Ana Maria Ruiz', 'Ruiz'], ['Sol', '']]);
  });

  it('says what is wrong with a row, and refuses a file without the columns', () => {
    const csv = 'pet_name,species,sex,birthday,owner_first_name,owner_last_name,owner_phone\nRex,,male,2020-01-01,Ana,Ruiz,3035550100\nRex,dog,male,2020-01-01,,Ruiz,3035550100\nRex,dog,male,2030-01-01,Ana,Ruiz,3035550100\nRex,dog,male,2020-01-01,Ana,,3035550100\n';
    expect(readPets(csv, '2026-10-18').map((r) => (r.ok ? 'ok' : r.message))).toEqual([
      'species is required, like dog or cat', 'owner_first_name is required', expect.stringContaining('birthday'), 'ok',
    ]);
    expect(readPets('first_name,last_name\nA,B\n', '2026-10-18')[0]).toMatchObject({ ok: false, message: expect.stringContaining('pet_name') });
  });

  it('says on the row when a kind of animal is not on the clinic\'s list: importing adds it', () => {
    const csv = 'pet_name,species,birthday,owner_name,owner_phone\nRex,Dog,2020-01-01,Ana Ruiz,3035550100\nNibbles,hamster,2024-01-01,Ana Ruiz,3035550100\n';
    expect(readPets(csv, '2026-10-18', true, ['Dog', 'Cat']).map((r) => r.ok && (r.note ?? null))).toEqual([null, 'adds "hamster" to your lists']);
  });

  it('reads an optional texts_ok column as a yes to reminder texts', () => {
    const csv = 'pet_name,species,birthday,owner_name,owner_phone,texts_ok\nRex,dog,2020-01-01,Ana Ruiz,3035550100,yes\nMia,cat,2020-01-01,Ana Ruiz,3035550100,\n';
    expect(readPets(csv, '2026-10-18').map((r) => r.ok && r.value.textsOk)).toEqual([true, false]);
  });
});
