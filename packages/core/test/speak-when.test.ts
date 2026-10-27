import { describe, expect, it } from 'vitest';
import { PACKS, speakSlot } from '../src';

// a time said on the phone: today, tomorrow, the weekday within the week, the date beyond it (2026-11)
const TZ = 'America/Denver';
const now = new Date('2026-09-28T16:00:00Z'); // Monday 10:00 in Denver
const at = (iso: string) => new Date(iso);

describe('speakWhen', () => {
  it.each([
    ['2026-09-28T20:30:00Z', 'today at 2:30 PM', 'hoy a las 2:30 p.m.'],
    ['2026-09-29T15:00:00Z', 'tomorrow at 9:00 AM', 'mañana a las 9:00 a.m.'],
    ['2026-10-01T20:30:00Z', 'Thursday at 2:30 PM', 'el jueves a las 2:30 p.m.'],
    ['2026-10-04T19:00:00Z', 'Sunday at 1:00 PM', 'el domingo a la 1:00 p.m.'],
    ['2026-10-05T15:00:00Z', 'Monday, October 5 at 9:00 AM', 'lunes, 5 de octubre a las 9:00 a.m.'],
  ])('%s with now: %s / %s', (iso, en, es) => {
    expect(PACKS.en.speakWhen(at(iso), TZ, now)).toBe(en);
    expect(PACKS.es.speakWhen(at(iso), TZ, now)).toBe(es);
    expect(speakSlot(at(iso), TZ, 'en', now)).toBe(en);
  });

  it('without now (a text read later) keeps the weekday and the date', () => {
    expect(PACKS.en.speakWhen(at('2026-09-28T20:30:00Z'), TZ)).toBe('Monday, September 28 at 2:30 PM');
    expect(PACKS.es.speakWhen(at('2026-09-28T20:30:00Z'), TZ)).toBe('lunes, 28 de septiembre a las 2:30 p.m.');
  });
});
