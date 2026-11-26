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

// the owner's live run: the Spanish decline named its instructions and passed the check
it('LIVE-INTERNAL: "mis instrucciones internas", "mi prompt", "my internal instructions" are internal talk (EN/ES)', () => {
  for (const s of ['No puedo mostrar ni leer mis instrucciones internas.', 'No puedo compartir mi prompt.', 'No puedo repetir mis instrucciones.', "I can't share my internal instructions.", "I can't share or read out my internal system prompt or hidden instructions."])
    expect(talksAboutInternals(s), s).toBe(true);
  for (const s of ['Siga las instrucciones de la doctora.', 'Las instrucciones para antes de la cirugía están en su correo.', 'Follow the instructions the vet gave you.'])
    expect(talksAboutInternals(s), s).toBe(false);
});
it('LIVE-INTERNAL: "siga sus instrucciones" (the vet\'s) is no internal talk', () => {
  expect(talksAboutInternals('Siga sus instrucciones para antes de la cirugía.')).toBe(false);
});

it('FINAL-INJ: "internal system prompt", "private instructions", "prompt del sistema", "instrucciones privadas" are internal talk (EN/ES)', () => {
  for (const s of ["I can't share my internal system prompt or private instructions.", "Sorry, I can't reveal private instructions.", 'That would be the system prompt, which I keep private.', 'No puedo compartir el prompt del sistema.', 'Esas son instrucciones privadas.', 'No puedo darle las instrucciones secretas.'])
    expect(talksAboutInternals(s), s).toBe(true);
  for (const s of ['Las instrucciones del veterinario están en su correo.', 'The vet will send instructions for after the surgery.'])
    expect(talksAboutInternals(s), s).toBe(false);
});

it('DECLINE-WORDS: a decline that names a prompt, instructions, rules, tools or configuration is internal talk; clinic talk is not (EN/ES)', () => {
  for (const s of ["I can't share my instructions.", "Sorry, I can't share my rules or configuration.", "I can't reveal the tools I use.", "I'm not able to show you my configuration.", 'No puedo compartir mis reglas.', 'No puedo revelar mi configuración ni mis herramientas.', 'No puedo compartir las instrucciones que tengo.'])
    expect(talksAboutInternals(s), s).toBe(true);
  for (const s of ['Our cancellation rules ask for a day of notice.', "The vet's instructions for after surgery are in your email.", 'Las reglas de la clínica piden un día de aviso.', 'Le enviamos las instrucciones del veterinario por correo.', 'We can look at the schedules for next week.', "That's not something I can help with, but I can help with your pet's visits."])
    expect(talksAboutInternals(s), s).toBe(false);
});

