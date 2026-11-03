import { describe, expect, it } from 'vitest';
import { PACKS, speakSlot } from '../src';

// a time said on the phone, and written in a text: always the weekday, the date and the time, never the year (2026-11-14).
// "today at 2:30" and "Thursday at 9" left the date to the caller, and a move to the next week went unsaid.
const TZ = 'America/Denver';
const now = new Date('2026-09-28T16:00:00Z'); // Monday 10:00 in Denver
const at = (iso: string) => new Date(iso);

describe('speakWhen', () => {
  it.each([
    ['2026-09-28T20:30:00Z', 'Monday, September 28, at 2:30 PM', 'el lunes 28 de septiembre a las 2:30 de la tarde'],
    ['2026-09-29T15:00:00Z', 'Tuesday, September 29, at 9:00 AM', 'el martes 29 de septiembre a las 9:00 de la mañana'],
    ['2026-10-01T20:30:00Z', 'Thursday, October 1, at 2:30 PM', 'el jueves 1 de octubre a las 2:30 de la tarde'],
    ['2026-10-04T19:00:00Z', 'Sunday, October 4, at 1:00 PM', 'el domingo 4 de octubre a la 1:00 de la tarde'],
    ['2026-10-05T15:00:00Z', 'Monday, October 5, at 9:00 AM', 'el lunes 5 de octubre a las 9:00 de la mañana'],
  ])('%s: %s / %s', (iso, en, es) => {
    expect(PACKS.en.speakWhen(at(iso), TZ, now)).toBe(en);
    expect(PACKS.es.speakWhen(at(iso), TZ, now)).toBe(es);
    expect(speakSlot(at(iso), TZ, 'en', now)).toBe(en);
    // a text read later says the same words as the call
    expect(PACKS.en.speakWhen(at(iso), TZ)).toBe(en);
  });
});
