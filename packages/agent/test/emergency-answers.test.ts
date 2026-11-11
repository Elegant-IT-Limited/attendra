import { describe, expect, it } from 'vitest';
import { answerTo, confirmsCleared, pastAndFineNow } from '../src/flow/emergency';

// Batch 1b: the caller's answer to "Is this still an emergency right now?", in English and Spanish.
describe('the answer to the emergency question', () => {
  it.each([
    ['Yes, please help', 'yes'], ['yeah she still can\'t breathe', 'yes'], ['Sí, ahora mismo', 'yes'], ['It\'s getting worse', 'yes'],
    ['I\'m not sure', 'unsure'], ['I don\'t know, maybe', 'unsure'], ['No sé', 'unsure'], ['no estoy segura', 'unsure'],
    ['No.', 'clear_no'], ['No, not now', 'clear_no'], ['She\'s fine now', 'clear_no'], ['It\'s a regular checkup', 'clear_no'],
    ['not swelling now, regular checkup at 3:30 with Dr. Alam', 'clear_no'], ['No, ya está bien', 'clear_no'], ['es solo una revisión', 'clear_no'],
    ['No, it\'s not an emergency', 'bare_not'], ['it\'s not an emergency', 'bare_not'], ['No es una emergencia', 'bare_not'],
    ['No, it\'s not an emergency, she\'s fine now', 'clear_no'], ['what time do you close?', null],
    ['Ya no se le hincha.', 'clear_no'], ['No sé, la verdad', 'unsure'], ['no se mueve', null],
  ])('"%s" → %s', (said, want) => expect(answerTo(said)).toBe(want));

  it('a red flag in the past with "fine now" in the same breath is already a clear no; yesterday is still asked', () => {
    expect(pastAndFineNow('Hi, my dog ate some chocolate last week, she\'s totally fine now, I just want a checkup.')).toBe(true);
    expect(pastAndFineNow('mi perra comió chocolate la semana pasada, ya está bien, quiero una revisión')).toBe(true);
    expect(pastAndFineNow('she ate chocolate yesterday but she\'s fine now')).toBe(false);
    expect(pastAndFineNow('she ate chocolate last week and now she\'s vomiting')).toBe(false);
  });
});

describe('doubts, questions and hopes never lift it', () => {
  it.each([
    ["I don't think he's okay, he's still not moving", 'yes'], ['Do you think she is okay?', null], ["I hope he's fine", null],
    ['No está bien, sigue sin moverse', 'yes'], ['¿Usted cree que ella está bien?', null], ["but he's fine now, it was a false alarm", 'clear_no'],
  ])('"%s" → %s', (said, want) => expect(answerTo(said)).toBe(want));

  it.each([
    ["Okay, but I'd like an appointment for him.", null], ['No.', null], ["No, forget it, he's not hurt", 'clear_no'], ["he's fine now, it's not an emergency", 'clear_no'],
    ['Do you think she is okay?', null], ["I hope he's fine", null], ["it's not an emergency", 'bare_not'],
  ])('after the route, "%s" → %s', (said, want) => expect(answerTo(said, true)).toBe(want));
});

// Note 49 B1 (a test call, 2026-11-10): "this is not emergency anymore" and "No, this is not emergency, I told you
// already" never lifted the hold, and before the route "It is not an emergency anymore." read as a yes.
describe('a retraction, with or without "an", with a question in the same breath', () => {
  it.each([
    ['this is not emergency anymore', 'clear_no'], ['No, this is not emergency, I told you already', 'bare_not'],
    ['This is not emergency anymore. Can I book a visit?', 'clear_no'], ["It's no longer an emergency.", 'clear_no'],
    ['Ya no es emergencia. ¿Puedo reservar una cita?', 'clear_no'], ['No, no es emergencia, ya se lo dije.', 'bare_not'],
    ['Can I book a visit?', null], ['Is he going to be okay?', null], ['I need an appointment for him.', null],
  ])('after the route, "%s" → %s', (said, want) => expect(answerTo(said, true)).toBe(want));

  it.each([
    ['It is not an emergency anymore.', 'bare_not'], ['It is not emergency.', 'bare_not'], ['it is getting worse', 'yes'], ['she is not breathing', 'yes'],
  ])('before the route, "%s" → %s', (said, want) => expect(answerTo(said)).toBe(want));
});

describe('the answer to "Just to check: <pet> doesn\'t need emergency care right now?"', () => {
  const langs = ['en', 'es'] as const;
  it.each([
    'Yes.', 'Yes, that\'s right.', 'Correct.', 'No, she doesn\'t.', 'He doesn\'t.', 'No, this is not emergency, I told you already.', 'Sí.', 'Correcto.', 'No, no la necesita.', 'Ya no es una emergencia.',
  ])('"%s" lifts it', (said) => expect(confirmsCleared(said, langs)).toBe(true));
  it.each([
    'No.', 'I don\'t know.', 'Maybe.', 'Yes, she still can\'t breathe.', 'She does need help.', 'It\'s getting worse.', 'No sé.', 'Sí la necesita.', 'Sigue mal.', 'Is she going to be okay?', 'Hmm.',
  ])('"%s" keeps it', (said) => expect(confirmsCleared(said, langs)).toBe(false));
});
