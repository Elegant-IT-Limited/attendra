// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { talksAboutInternals } from '../src';
// Note 49 B2: a test call heard the assistant talk about its own workings.
it('flags talk about how the assistant works, EN and ES, and nothing a front desk says', () => {
  for (const s of ["It's still running in the background", 'The information I got back is an address', 'the information returned is only an address', 'I got back an address', 'Let me check the system', 'La información que recibí es solo una dirección', 'Sigue en segundo plano'])
    expect(talksAboutInternals(s), s).toBe(true);
  for (const s of ['One moment.', 'Our address is 12 Main Street.', 'I can have someone call you back.', 'I found Biscuit, your dog.', 'Is the profile under the number ending 0172?', "We're open until 6 PM today.", 'Your dog is booked for Tuesday at 3 PM.', 'Un momento.', 'If it comes back, call us'])
    expect(talksAboutInternals(s), s).toBe(false);
});
