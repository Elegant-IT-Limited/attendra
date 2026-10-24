// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { callUsNumber, readablePhone, renderText } from '../src';

describe('personal texts', () => {
  const clinic = { clinic: 'Willow Creek Pet Clinic', clinicPhone: '+17205550161', when: 'Wednesday, October 28 at 10:00 AM' };

  it('names the owner, the pet, the visit and the vet when the call gave them, with the number readable', () => {
    expect(renderText('booking_confirmed', { ...clinic, name: 'Sam', pet: 'Scout', visit: 'check-up', provider: 'Dr. Ruiz' }))
      .toBe("Willow Creek Pet Clinic: Hi Sam, Scout's check-up with Dr. Ruiz is booked for Wednesday, October 28 at 10:00 AM. To change or cancel, call (720) 555-0161. Reply STOP to opt out.");
  });

  it('reads well with no names at all, and in Spanish', () => {
    expect(renderText('booking_confirmed', clinic)).toBe('Willow Creek Pet Clinic: Your visit is booked for Wednesday, October 28 at 10:00 AM. To change or cancel, call (720) 555-0161. Reply STOP to opt out.');
    expect(renderText('request_ready', { ...clinic, name: 'Sam', pet: 'Scout' }, 'es')).toMatch(/^Willow Creek Pet Clinic: Hola Sam, /);
  });

  it('asks people to call the clinic\'s own line, not the assistant, and keeps numbers outside North America as given', () => {
    expect(callUsNumber({ phoneNumbers: ['+17205550160', '+17205550161'] })).toBe('+17205550161');
    expect(callUsNumber({ phoneNumbers: ['+17205550160'] })).toBe('+17205550160');
    expect(readablePhone('+442079460000')).toBe('+442079460000');
  });
});
