import { describe, expect, it } from 'vitest';
import { doctorGuide, doctorTemplate, needsPhone, providerPhoneIssues, readDoctors, RIVERBEND_CLINIC, sharedProviderPhones, starterClinic } from '../src';

const vets = starterClinic({ id: 'clinic_v', name: 'Oak Hill Vets', timezone: 'America/Chicago', industry: 'vet', phone: '+13125550100' });
const withVet = {
  ...vets,
  providers: [...vets.providers, { id: 'prov_marsh', name: 'Dr. Elena Marsh', gender: 'female' as const, kind: 'person' as const, categories: ['Dogs'], timeOff: [], acceptingNewPatients: true, visitTypeIds: ['vt_sick'], phone: '+17205550181', otherPhones: ['+17205550183'] }],
};

// the number is the vet (the clinic's rule, 2026-11-01): one per clinic, the same one at another clinic is fine
describe('a veterinarian is told apart by their phone number', () => {
  it('needs a number for a new person at a vet clinic, never for a room, the stand-in or a doctor at a clinic for people', () => {
    expect(providerPhoneIssues(vets, { kind: 'person' }).issues).toEqual([{ path: 'phone', message: 'A phone number is needed: it is what tells one veterinarian from another.' }]);
    expect(providerPhoneIssues(vets, { kind: 'room' }).issues).toEqual([]);
    expect(providerPhoneIssues(vets, { kind: 'person', placeholder: true }).issues).toEqual([]);
    expect(providerPhoneIssues({ ...vets, industry: 'clinic' }, { kind: 'person' }).issues).toEqual([]);
    // a vet already on file without one keeps saving, and the page asks for it
    expect(providerPhoneIssues(withVet, { kind: 'person' }, 'prov_marsh').issues).toEqual([]);
    expect(needsPhone(vets, { kind: 'person', phone: undefined })).toBe(true);
    expect(needsPhone(vets, { kind: 'person', phone: undefined, placeholder: true })).toBe(false);
    expect(needsPhone(vets, { kind: 'person', phone: '+17205550181' })).toBe(false);
  });

  it('keeps the number as the clinic dials it, refuses one that is not a number, and one listed twice', () => {
    expect(providerPhoneIssues(vets, { phone: '(720) 555-0182', otherPhones: ['720 555 0184'] })).toEqual({ phone: '+17205550182', otherPhones: ['+17205550184'], issues: [] });
    expect(providerPhoneIssues(vets, { phone: '55' }).issues[0]).toMatchObject({ path: 'phone', message: expect.stringContaining('Check the phone number') });
    expect(providerPhoneIssues(vets, { phone: '(720) 555-0182', otherPhones: ['7205550182'] }).issues).toEqual([{ path: 'otherPhones', message: 'The same number is listed twice.' }]);
  });

  it('refuses a number another vet at the clinic has, under the field it was typed in, and says whose it is', () => {
    expect(providerPhoneIssues(withVet, { phone: '720-555-0181' }).issues).toEqual([{ path: 'phone', message: 'Dr. Elena Marsh already has this number.' }]);
    // one of her other numbers, given as the new vet's own: still hers
    expect(providerPhoneIssues(withVet, { phone: '+17205550183' }).issues).toEqual([{ path: 'phone', message: 'Dr. Elena Marsh already has this number.' }]);
    expect(providerPhoneIssues(withVet, { phone: '+17205550189', otherPhones: ['+17205550181'] }).issues).toEqual([{ path: 'otherPhones', message: 'Dr. Elena Marsh already has this number.' }]);
    // her own number on her own record is not a clash
    expect(providerPhoneIssues(withVet, { phone: '+17205550181' }, 'prov_marsh').issues).toEqual([]);
    // the same number at another clinic is fine
    expect(providerPhoneIssues(vets, { phone: '+17205550181' }).issues).toEqual([]);
  });

  it('counts the numbers shared between providers, and nothing else, for the provisioning report', () => {
    expect(sharedProviderPhones(withVet.providers)).toEqual({ numbers: 0, providers: 0 });
    const twin = { ...withVet.providers[1]!, id: 'prov_twin', name: 'Dr. Twin', otherPhones: undefined };
    expect(sharedProviderPhones([...withVet.providers, twin])).toEqual({ numbers: 1, providers: 2 });
  });
});

describe('the doctor import with phone numbers and the clinic\'s own fields', () => {
  const fields = [{ id: 'cf_licence', label: 'Licence number', kind: 'text' as const }, { id: 'cf_fear_free', label: 'Fear Free', kind: 'yesno' as const }];
  const clinic = { ...withVet, providerFields: fields };

  it('finds the vet on file by their number before their name, needs a number for a new vet, and refuses a number another vet has', () => {
    const rows = readDoctors([
      'name,phone,other_phones,specialty,categories,licence_number,fear_free',
      'Dr. E. Marsh (renamed),(720) 555-0181,,,Cats,CO-0161,yes',
      'Dr. New Vet,(720) 555-0185,(720) 555-0186; (720) 555-0187,,Dogs,,',
      'Dr. No Number,,,,Dogs,,',
      'Dr. Taken,720 555 0183,,,Dogs,,',
      'Dr. Marsh Again,,,,Cats,,',
      'Dr. Twice,720 555 0185,,,Dogs,,',
      'Dr. Bad Field,720 555 0188,,,Dogs,,maybe',
    ].join('\n'), clinic);
    expect(rows.map((r) => (r.ok ? `ok:${r.existingId ?? 'new'}` : `error:${r.message}`))).toEqual([
      'ok:prov_marsh',
      'ok:new',
      'error:phone: A phone number is needed: it is what tells one veterinarian from another.',
      // her other number on a row of its own is her, renamed: the number is the vet, and she is on a row already
      'error:Dr. Elena Marsh is already on another row of the file (the same number or name)',
      'error:phone: A phone number is needed: it is what tells one veterinarian from another.',
      'error:phone: another row in the file has this number',
      'error:Fear Free: yes or no',
    ]);
    const marsh = rows[0]!.ok ? rows[0]!.value : null;
    expect(marsh).toMatchObject({ id: 'prov_marsh', name: 'E. Marsh (renamed)', phone: '+17205550181', otherPhones: ['+17205550183'], categories: ['Cats'], custom: { cf_licence: 'CO-0161', cf_fear_free: 'yes' } });
    const fresh = rows[1]!.ok ? rows[1]!.value : null;
    expect(fresh).toMatchObject({ phone: '+17205550185', otherPhones: ['+17205550186', '+17205550187'] });
  });

  it('a clinic for people keeps importing doctors without a number', () => {
    const rows = readDoctors('name,specialty\nDr. Lee Park,Dermatology', { ...RIVERBEND_CLINIC, industry: 'clinic', providers: [], lists: undefined });
    expect(rows[0]).toMatchObject({ ok: true });
  });

  it('the template and its guide list the columns that exist today: the phone, the clinic\'s lists and its own fields, with an example row', () => {
    const csv = doctorTemplate(clinic);
    const [header, example] = csv.split(/\r?\n/);
    expect(header).toBe('id,name,gender,phone,other_phones,specialty,categories,ages_min,ages_max,accepting_new_patients,visit_types,mon,tue,wed,thu,fri,sat,sun,time_off,licence_number,fear_free');
    expect(example).toContain('(303) 555-0100');
    expect(example).toContain('Dogs; Cats');
    const guide = doctorGuide(clinic);
    expect(guide.join('\n')).toContain('phone for a new veterinarian');
    expect(guide.join('\n')).toContain('from your list (Dogs, Cats, Rabbits, Birds, Reptiles, Small mammals, Exotic pets)');
    expect(guide.join('\n')).toContain('licence_number: your own field "Licence number"');
    expect(guide.join('\n')).toContain('fear_free: your own field "Fear Free", yes or no');
    expect(guide.join('\n')).not.toContain('ages_min');
    // a clinic for people keeps the ages line, and the plain example
    expect(doctorGuide({ visitTypes: [], industry: 'clinic' }).join('\n')).toContain('ages_min and ages_max');
    expect(doctorTemplate({ visitTypes: [] }).split('\n')[1]).toContain('Family medicine');
  });
});
