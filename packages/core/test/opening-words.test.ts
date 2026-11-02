import { describe, expect, it } from 'vitest';
import { DEFAULT_RECORDING_NOTICE, noticeIsSentence, openingWords } from '../src';

describe('the recording notice comes before the question', () => {
  const greeting = "Thanks for calling Riverbend Animal Hospital. I'm Juniper, the clinic's AI assistant. How can I help you today?";
  it('puts the notice after the names and before the question', () => {
    expect(openingWords(greeting, DEFAULT_RECORDING_NOTICE.en)).toBe("Thanks for calling Riverbend Animal Hospital. I'm Juniper, the clinic's AI assistant. This call may be recorded for quality and safety. How can I help you today?");
    expect(openingWords('Gracias por llamar a Riverbend. Le habla Juniper, el asistente de IA de la clínica. ¿En qué le puedo ayudar?', DEFAULT_RECORDING_NOTICE.es))
      .toBe('Gracias por llamar a Riverbend. Le habla Juniper, el asistente de IA de la clínica. Esta llamada puede ser grabada por motivos de calidad y seguridad. ¿En qué le puedo ayudar?');
  });
  it('adds it after a greeting with no question, and changes nothing without one', () => {
    expect(openingWords('Riverbend, this is the AI assistant.', 'Calls are recorded.')).toBe('Riverbend, this is the AI assistant. Calls are recorded.');
    expect(openingWords(greeting, null)).toBe(greeting);
    expect(openingWords(greeting, '  ')).toBe(greeting);
  });
  it('hints when a notice does not read as a sentence, without changing it', () => {
    expect(noticeIsSentence(DEFAULT_RECORDING_NOTICE.en)).toBe(true);
    expect(noticeIsSentence('recorded')).toBe(false);
    expect(noticeIsSentence('this call is recorded')).toBe(false);
  });
});
