// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { callUsNumber, readablePhone, renderText } from '../src';

describe('personal texts', () => {
  const clinic = { clinic: 'Zaru Pet Clinic', clinicPhone: '+15164472575', when: 'Wednesday, October 28 at 10:00 AM' };

  it('names the owner, the pet, the visit and the vet when the call gave them, with the number readable', () => {
    expect(renderText('booking_confirmed', { ...clinic, name: 'Abdul', pet: 'Flippy', visit: 'check-up', provider: 'Dr. Ruiz' }))
      .toBe("Zaru Pet Clinic: Hi Abdul, Flippy's check-up with Dr. Ruiz is booked for Wednesday, October 28 at 10:00 AM. To change or cancel, call (516) 447-2575. Reply STOP to opt out.");
  });

  it('reads well with no names at all, and in Spanish', () => {
    expect(renderText('booking_confirmed', clinic)).toBe('Zaru Pet Clinic: Your visit is booked for Wednesday, October 28 at 10:00 AM. To change or cancel, call (516) 447-2575. Reply STOP to opt out.');
    expect(renderText('request_ready', { ...clinic, name: 'Abdul', pet: 'Flippy' }, 'es')).toMatch(/^Zaru Pet Clinic: Hola Abdul, /);
  });

  it('asks people to call the clinic\'s own line, not the assistant, and keeps numbers outside North America as given', () => {
    expect(callUsNumber({ phoneNumbers: ['+15163630790', '+15164472575'] })).toBe('+15164472575');
    expect(callUsNumber({ phoneNumbers: ['+15163630790'] })).toBe('+15163630790');
    expect(readablePhone('+442079460000')).toBe('+442079460000');
  });
});
