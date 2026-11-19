// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { forVapiVoice, fromVapiVoice } from '../src';

// V3 (2026-11-18): Vapi's voice said "with Doctor. Maya Chen" (a pause after the title) and "8 8 30, or 9 AM" for 8:00,
// 8:30 and 9:00. What reaches Vapi has the title in full and a time on the hour as the hour alone. Made-up names.
describe('text for Vapi\'s voice', () => {
  it('says the title in full, with no period to pause on', () => {
    expect(forVapiVoice('On Thursday, October 1, I have 8:00, 8:30 or 9:00 AM with Dr. Maya Chen.')).toBe('On Thursday, October 1, I have 8, 8:30 or 9 AM with Doctor Maya Chen.');
    expect(forVapiVoice('El jueves tengo a las 8:00, 8:40 o 9:00 de la mañana, con Dra. Ana Ruiz.')).toBe('El jueves tengo a las 8, 8:40 o 9 de la mañana, con Doctora Ana Ruiz.');
    expect(forVapiVoice('at 4:00 PM with Dr. Lee, 5:00 PM with Dr. Kim')).toBe('at 4 PM with Doctor Lee, 5 PM with Doctor Kim');
    expect(forVapiVoice('I have 8:00, 8:30, or 9:00 AM')).toBe('I have 8, 8:30, or 9 AM');
  });

  it('leaves 24-hour times, times with no part of the day, ids and a lowercase "dr." as they are', () => {
    expect(forVapiVoice('Today the clinic is open 08:00 to 12:00 and 13:00 to 17:00.')).toBe('Today the clinic is open 08:00 to 12:00 and 13:00 to 17:00.');
    expect(forVapiVoice('{"slot_id":"slot_x_2026-10-01T10:00:00.000Z","when":"Thursday, October 1, at 10:00 AM"}')).toBe('{"slot_id":"slot_x_2026-10-01T10:00:00.000Z","when":"Thursday, October 1, at 10 AM"}');
    expect(forVapiVoice('call at 9:00 tomorrow, 12 Elm dr. North')).toBe('call at 9:00 tomorrow, 12 Elm dr. North');
  });

  it('reads the assistant\'s spaced times back as clock times, never a phone number', () => {
    expect(fromVapiVoice('Thursday at 8 30 AM with Doctor Maya Chen')).toBe('Thursday at 8:30 AM with Doctor Maya Chen');
    expect(fromVapiVoice('I have 8 8 30, or 9 AM')).toBe('I have 8 8:30, or 9 AM');
    expect(fromVapiVoice('a las 9 15 de la mañana')).toBe('a las 9:15 de la mañana');
    expect(fromVapiVoice('the number 555 0123')).toBe('the number 555 0123');
  });
});
