import { describe, expect, it } from 'vitest';
import { groupClinics, switcherTitle } from '../lib/clinics';

// the switcher groups a business's locations under its name; a business with one clinic is one row (2026-11)
const willow = (id: string, name: string) => ({ id, name, role: 'Owner', organizationId: 'org_willow', organizationName: 'Willow Bend Animal Clinic' });
const juniper = { id: 'c_j', name: 'Juniper Hill Pet Care', role: 'Owner', organizationId: 'org_juniper', organizationName: 'Juniper Hill Pet Care' };

describe('groupClinics', () => {
  it('nests two or more locations under their business, and leaves a single clinic as its own row', () => {
    const groups = groupClinics([willow('c_1', 'Main'), willow('c_2', 'Downtown'), juniper]);
    expect(groups).toEqual([
      { id: 'org_willow', name: 'Willow Bend Animal Clinic', clinics: [willow('c_1', 'Main'), willow('c_2', 'Downtown')] },
      { id: 'org_juniper', name: null, clinics: [juniper] },
    ]);
  });

  it('a clinic with no business known is a row of its own', () => {
    const lone = { id: 'c_x', name: 'Willow Bend', role: 'Front desk' };
    expect(groupClinics([lone, juniper])).toEqual([{ id: 'c_x', name: null, clinics: [lone] }, { id: 'org_juniper', name: null, clinics: [juniper] }]);
  });
});

describe('switcherTitle', () => {
  it('says "Business · Location" only for a location of a business with several', () => {
    const all = [willow('c_1', 'Main'), willow('c_2', 'Downtown'), juniper];
    expect(switcherTitle(willow('c_2', 'Downtown'), all)).toBe('Willow Bend Animal Clinic · Downtown');
    expect(switcherTitle(juniper, all)).toBe('Juniper Hill Pet Care');
    expect(switcherTitle(willow('c_1', 'Main'), [willow('c_1', 'Main')])).toBe('Main');
  });
});
