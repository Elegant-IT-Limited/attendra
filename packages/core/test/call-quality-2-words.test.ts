import { describe, expect, it } from 'vitest';
import { detectEmergencies, industryPack, newToClinic } from '../src';

// Call quality round 2 (2026-11-19): R2 "So, what's about the emergency?" ran the danger question; R6 "a new puppy" was
// looked up as if on file.
const VET = industryPack('vet').emergency!.phrases;
const general = (t: string) => detectEmergencies(t, VET).filter((m) => m.kind === 'general').length;

describe('a question about the clinic\'s emergencies (R2)', () => {
  it('is no emergency: "what about the emergency?", "and emergencies?", "your emergency policy", Spanish too', () => {
    for (const t of ["Let me check. So, what's about the emergency?", 'How about emergencies?', 'What is your emergency policy?', 'What do you do about emergencies?', '¿Y las emergencias?', '¿Qué pasa con las urgencias?', '¿Cuál es su horario de emergencias?']) expect(general(t), t).toBe(0);
  });
  it('still is when they say there is one', () => {
    for (const t of ["It's an emergency!", 'This is an emergency, what about the emergency vet?']) expect(general(t), t).toBeGreaterThan(0);
  });
});

describe('a new puppy (R6)', () => {
  it('is new, in English and Spanish', () => {
    for (const t of ['Book a new puppy, his name is Rocky', 'I have a new kitten', 'Es un cachorro nuevo', 'Tengo un gatito nuevo']) expect(newToClinic(t), t).toBe('new');
  });
});
