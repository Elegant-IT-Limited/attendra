// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { talksAboutInternals } from '../src';

// T5, a tester's call (2026-11-24): the assistant explained its own state instead of saying the corrected action.
it('T5: flags a change explained as internal state, EN and ES, and nothing a front desk says', () => {
  for (const s of [
    'The earlier tentative change won\'t be used.', 'The last change I had waiting to confirm was set to cancel the Saturday appointment.',
    'One moment, I\'ll cancel the one booked on this call instead.', 'That pending change is dropped.',
    'El cambio pendiente no se usará.', 'El cambio provisional ya no se va a hacer.',
  ]) expect(talksAboutInternals(s), s).toBe(true);
  for (const s of ['So I\'d cancel Saturday at 9:20 AM with Dr. Bell. Is that right?', 'Shall I book it?', 'Your visit is booked.', '¿Le reservo esa cita?', 'Is that the visit you want to cancel?'])
    expect(talksAboutInternals(s), s).toBe(false);
});

// review 4: ordinary lines are no internal talk
it('MP-INTERNAL-review4: ordinary lines about the team, a request or the clinic are not flagged; the real internal phrases are', () => {
  for (const s of ['The team is processing your refill request.', "We're processing your request now.", 'Our system will text you a confirmation.', 'Is the clinic still running the vaccine clinic on Saturdays?'])
    expect(talksAboutInternals(s), s).toBe(false);
  for (const s of ['Let me check the system.', 'The tool returned nothing.', 'The lookup is slow.', 'That pending change is dropped.', "It's still running in the background.", 'Still waiting on that.'])
    expect(talksAboutInternals(s), s).toBe(true);
});
