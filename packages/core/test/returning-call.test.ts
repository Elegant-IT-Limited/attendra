import { describe, expect, it } from 'vitest';
import { isReturningCall, PACKS } from '../src';

describe('a caller returning a missed call from this number', () => {
  it('hears it in English and Spanish, as people say it', () => {
    for (const said of [
      'Hi, I got a missed call from this number', 'I had a missed call from you', 'Someone called me from this number', 'Yeah, you guys called me',
      'I\'m returning your call', 'Returning a call from this number', 'Who just called me?', 'Why did you call me?', 'I\'m calling you back',
      'Hola, tengo una llamada perdida de este número', 'Me llamaron de este número', 'Alguien me llamó', 'Estoy devolviendo la llamada', '¿Quién me llamó?',
    ]) expect(isReturningCall(said), said).toBe(true);
  });

  it('is not a client calling back about their own request, a booking, or a question', () => {
    for (const said of [
      'I\'d like to book a visit for my dog', 'I\'m calling back about my refill', 'Can you call me back later?', 'I\'ll call back tomorrow', 'What are your hours?',
      'Quiero reservar una cita', 'Llamo por la receta de mi perro', '¿Me pueden llamar más tarde?',
    ]) expect(isReturningCall(said), said).toBe(false);
  });

  it('has the line in both languages, with the clinic\'s name, the AI said plainly and the message offered', () => {
    const en = PACKS.en.returnedCallLine({ clinic: 'Oak Hill Vets' });
    const es = PACKS.es.returnedCallLine({ clinic: 'Oak Hill Vets' });
    expect(en).toBe('This is Oak Hill Vets\'s phone assistant. The clinic doesn\'t usually call out from this line, so the call you got may not have come from us. Are you a client of Oak Hill Vets, or can I take a message for the team?');
    expect(es).toContain('puede no haber sido nuestra');
    expect(es).toContain('dejar un mensaje para el equipo');
    expect(PACKS.en.spoken.noTransfer).toBe('I can\'t put you through right now, but I\'ll have the team call you back. What\'s it about?');
    expect(PACKS.es.spoken.noTransfer).toContain('no puedo pasarle con nadie');
  });
});
