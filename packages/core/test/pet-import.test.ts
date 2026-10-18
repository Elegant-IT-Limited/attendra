import { describe, expect, it } from 'vitest';
import { petTemplate, readPets } from '../src';

describe('importing pets', () => {
  it('reads the template as pets stored the way the assistant stores them', () => {
    const rows = readPets(petTemplate(), '2026-10-18');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ok: true, value: { firstName: 'Biscuit', lastName: 'Rivera', guardianName: 'Jordan Rivera', species: 'dog', gender: 'female', dob: '2021-05-14' } });
    expect(rows[1]).toMatchObject({ ok: true, value: { firstName: 'Mochi', species: 'cat', gender: 'undisclosed' } });
  });

  it('says what is wrong with a row, and refuses a file without the columns', () => {
    const csv = 'pet_name,species,sex,birthday,owner_name,owner_phone\nRex,,male,2020-01-01,Ana Ruiz,3035550100\nRex,dog,male,2020-01-01,Ana,3035550100\nRex,dog,male,2030-01-01,Ana Ruiz,3035550100\n';
    expect(readPets(csv, '2026-10-18').map((r) => (r.ok ? 'ok' : r.message))).toEqual([
      'species is required, like dog or cat', 'owner_name needs the owner\'s first and last name', expect.stringContaining('birthday'),
    ]);
    expect(readPets('first_name,last_name\nA,B\n', '2026-10-18')[0]).toMatchObject({ ok: false, message: expect.stringContaining('pet_name') });
  });
});
