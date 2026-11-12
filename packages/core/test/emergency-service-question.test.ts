import { describe, expect, it } from 'vitest';
import { detectEmergencies } from '../src';

const kinds = (text: string) => detectEmergencies(text).map((m) => m.kind);

// note 52 B6: "Do you receive emergency?" asked about the clinic and heard "Is this still an emergency right now?"
describe('a question about the clinic\'s emergency service is not an emergency', () => {
  it('asks about the service: no red flag, EN and ES', () => {
    for (const q of ['Do you receive emergency?', 'Do you handle emergencies?', 'Do you guys take emergencies?', 'Does the clinic see emergencies?', 'Can your vets treat emergencies?',
      'Are you open for emergencies?', 'How do you handle emergencies?', 'What are your emergency hours?', '¿Atienden emergencias?', '¿Reciben urgencias?', '¿Tienen servicio de emergencias?'])
      expect(kinds(q), q).toEqual([]);
  });

  it('a report still holds the call: the word with "it is one", and every animal-in-danger sign', () => {
    expect(kinds('Do you handle emergencies? It\'s an emergency, please.')).toContain('general');
    expect(kinds('¿Atienden emergencias? Es una emergencia.')).toContain('general');
    expect(kinds('This is an emergency')).toEqual(['general']);
    // the specific signs are untouched by the question
    expect(kinds('Do you take emergencies? My dog is not breathing').length).toBeGreaterThan(0);
    expect(kinds('Do you take emergencies? My dog is not breathing')).not.toEqual(['general']);
  });
});
