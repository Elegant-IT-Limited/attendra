import { describe, expect, it } from 'vitest';
import { asksForText, isClearYes, isClearYesTo } from '../src/confirmation';
import { zonedInstant } from '../src/time';

// Call quality Q2 and Q3 (2026-11-18): "Ya" to a text offer was taken as a no, "can you send me the text?" was refused
// as no clear yes, and "Okay, 9:20 is fine." to a booking's read-back was asked again.
const BOTH = ['en', 'es'] as const;

describe('a plain yes, in other words', () => {
  it('counts "ya", "yeah", "yep", "sure", "ok", "okay, that works" and "sí", "ok", "dale"', () => {
    for (const yes of ['Ya', 'ya.', 'Yeah', 'yep', 'Sure', 'ok', 'Okay.', 'Okay, that works.', 'That works for me', 'Okay, 9:20 is fine.', 'Sounds good']) expect(isClearYes(yes, BOTH), yes).toBe(true);
    for (const yes of ['Sí', 'sí.', 'Ok', 'okey', 'Dale', 'Está bien']) expect(isClearYes(yes, BOTH), yes).toBe(true);
  });

  it('never a hedge, a question or a no', () => {
    for (const no of ['Okay, but not Friday', 'Okay?', 'Ya, wait', 'No', 'Maybe later', 'Is that fine?', 'Sí, pero espere', 'Hello']) expect(isClearYes(no, BOTH), no).toBe(false);
  });

  it('"ya" alone counts only as the whole answer', () => {
    expect(isClearYes('ya me voy', BOTH)).toBe(false);
  });
});

describe('an answer naming the time offered', () => {
  const when = { start: zonedInstant('2026-11-18', '09:20', 'America/New_York'), timeZone: 'America/New_York' };
  it('is a yes to the read-back: "9:20", "yes, 9:20", "9:20 please", "a las 9:20"', () => {
    for (const yes of ['9:20', 'Yes, 9:20.', '9:20 please', 'nine twenty', 'A las 9:20.']) expect(isClearYesTo(yes, BOTH, when), yes).toBe(true);
  });
  it('is not with a hedge, a question or another time', () => {
    for (const no of ['9:20?', '9:20, but on Friday', 'No, 9:40', '8:00']) expect(isClearYesTo(no, BOTH, when), no).toBe(false);
  });
});

describe('the caller asking for the text', () => {
  it('is asking: "can you send me the text?", "you can send me text", "send me a text the details", "text me", Spanish too', () => {
    for (const ask of ['Can you send me the text?', 'You can send me text.', 'Can you send me a text the details?', 'Text me the address please', 'Could you send that to me by text?', 'Send me the details by text', '¿Me lo puede mandar por mensaje?', 'Envíeme un mensaje con los detalles', 'Mándeme un texto']) expect(asksForText(ask), ask).toBe(true);
  });
  it('is not: a no, a missing text, or a question about texts', () => {
    for (const not of ["Don't text me", 'No text please', "I didn't get the text", 'Do you send reminder texts?', 'No me mande mensajes', 'No recibí el mensaje']) expect(asksForText(not), not).toBe(false);
  });
});

describe('a stray fragment from the room (call quality Q5)', () => {
  it('is one or two words wholly in another language: "Excelente", "Quiero" on an English call, "Come here" on a Spanish one', async () => {
    const { strayFragment } = await import('../src/confirmation');
    for (const t of ['Excelente.', 'Quiero.', 'Bueno, mira']) expect(strayFragment(t, 'en'), t).toBe(true);
    for (const t of ['Come here', 'Hey']) expect(strayFragment(t, 'es'), t).toBe(true);
  });
  it('is never the call\'s own words, a yes or no, a number, a name, or a request to end the call', async () => {
    const { strayFragment } = await import('../src/confirmation');
    for (const t of ['Yes.', 'Bella.', 'No.', '0174', 'Hang up.', 'Bye', 'Thanks', 'Okay']) expect(strayFragment(t, 'en'), t).toBe(false);
    for (const t of ['Sí.', 'Hang up.', 'No.', 'Luna', 'Ok', 'Claro']) expect(strayFragment(t, 'es'), t).toBe(false);
    // three words or more is the caller's sentence, as the language rule reads it
    expect(strayFragment('Quiero una cita', 'en')).toBe(false);
  });
  it('said again, is the caller\'s', async () => {
    const { strayFragment, fragmentKey } = await import('../src/confirmation');
    expect(strayFragment('Quiero.', 'en', fragmentKey('Quiero'))).toBe(false);
  });
});
