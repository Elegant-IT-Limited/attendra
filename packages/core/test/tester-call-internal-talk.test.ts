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
  for (const s of ['So I\'d cancel Saturday at 9:20 AM with Dr. Patel. Is that right?', 'Shall I book it?', 'Your visit is booked.', '¿Le reservo esa cita?', 'Is that the visit you want to cancel?'])
    expect(talksAboutInternals(s), s).toBe(false);
});
