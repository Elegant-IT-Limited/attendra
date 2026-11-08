// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { AddMember, DoctorInput, PatientInput, ProfileName, TransferNumber } from '../src/contracts';

// Note 15, the field standard (docs/field-standard.md): the API refuses what the browser would, even when the browser
// is skipped. Each schema here is what the route's ZodPipe checks.
const message = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0]?.message;
const NOT_A_NAME = 'type a name, not only spaces or symbols';

describe('names have a letter or a digit in them, not only spaces or symbols', () => {
  const pet = { firstName: 'Biscuit', dob: '2021-03-04', phone: '(720) 555-0101', gender: 'male' };
  it('a vet, a person\'s own name and a teammate invited by name', () => {
    const vet = { name: '!!', gender: 'female', allLocations: false, kind: 'person', specialty: '', categories: [], acceptingNewPatients: true, timeOff: [], visitTypeIds: ['vt_sick'] };
    expect(message(DoctorInput.safeParse(vet))).toBe(NOT_A_NAME);
    expect(DoctorInput.safeParse({ ...vet, name: 'Dr. Lena Ortiz' }).data?.name).toBe('Lena Ortiz');
    expect(message(ProfileName.safeParse({ name: '-- ..' }))).toBe(NOT_A_NAME);
    expect(ProfileName.safeParse({ name: '  Ana Front  ' }).data).toEqual({ name: 'Ana Front' });
    expect(message(AddMember.safeParse({ name: '@@', email: 'kai@example.com', role: 'staff' }))).toBe(NOT_A_NAME);
    expect(AddMember.safeParse({ name: '', email: 'kai@example.com', role: 'staff' }).success).toBe(true); // the name is optional
  });

  it('an owner\'s last name and a parent or guardian: empty is fine, symbols alone are not', () => {
    expect(message(PatientInput.safeParse({ ...pet, lastName: '...' }))).toBe(NOT_A_NAME);
    expect(message(PatientInput.safeParse({ ...pet, guardianName: ' - ' }))).toBe(NOT_A_NAME);
    expect(PatientInput.safeParse({ ...pet, lastName: '', guardianName: null }).success).toBe(true);
    expect(PatientInput.safeParse({ ...pet, lastName: " O'Brien ", guardianName: 'Jo Ann Lee-Park' }).data).toMatchObject({ lastName: "O'Brien", guardianName: 'Jo Ann Lee-Park' });
  });
});

describe('my own transfer number', () => {
  it('is typed as people write it, numbers only; empty clears it', () => {
    expect(TransferNumber.safeParse({ number: ' (303) 555-0123 ' }).data).toEqual({ number: '(303) 555-0123' });
    expect(message(TransferNumber.safeParse({ number: '303 CALL NOW' }))).toBe('Use numbers only, for example (555) 555-0123.');
    expect(TransferNumber.safeParse({ number: '' }).data).toEqual({ number: null });
    expect(TransferNumber.safeParse({ number: null }).data).toEqual({ number: null });
  });
});
