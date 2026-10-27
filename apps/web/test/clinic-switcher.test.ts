import { describe, expect, it } from 'vitest';
import { groupClinics, switcherTitle } from '../lib/clinics';

// the switcher groups a business's locations under its name; a business with one clinic is one row (2026-11)
const lake = (id: string, name: string) => ({ id, name, role: 'Owner', organizationId: 'org_lake', organizationName: 'Lake View Veterinary' });
const zaru = { id: 'c_z', name: 'Zaru Animal Hospital', role: 'Owner', organizationId: 'org_zaru', organizationName: 'Zaru Animal Hospital' };

describe('groupClinics', () => {
  it('nests two or more locations under their business, and leaves a single clinic as its own row', () => {
    const groups = groupClinics([lake('c_1', 'Main'), lake('c_2', 'Downtown'), zaru]);
    expect(groups).toEqual([
      { id: 'org_lake', name: 'Lake View Veterinary', clinics: [lake('c_1', 'Main'), lake('c_2', 'Downtown')] },
      { id: 'org_zaru', name: null, clinics: [zaru] },
    ]);
  });

  it('a clinic with no business known is a row of its own', () => {
    const lone = { id: 'c_x', name: 'Willow Bend', role: 'Front desk' };
    expect(groupClinics([lone, zaru])).toEqual([{ id: 'c_x', name: null, clinics: [lone] }, { id: 'org_zaru', name: null, clinics: [zaru] }]);
  });
});

describe('switcherTitle', () => {
  it('says "Business · Location" only for a location of a business with several', () => {
    const all = [lake('c_1', 'Main'), lake('c_2', 'Downtown'), zaru];
    expect(switcherTitle(lake('c_2', 'Downtown'), all)).toBe('Lake View Veterinary · Downtown');
    expect(switcherTitle(zaru, all)).toBe('Zaru Animal Hospital');
    expect(switcherTitle(lake('c_1', 'Main'), [lake('c_1', 'Main')])).toBe('Main');
  });
});
