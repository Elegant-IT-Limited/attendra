import { describe, expect, it } from 'vitest';
import { dayShift, groupSlotsByDay, offerTimesLine, PACKS, type Slot, zonedInstant } from '../src';

// every time said in full: the weekday, the date and the time, in the clinic's zone, never the year (2026-11-14)
const TZ = 'America/Denver';
const at = (date: string, time: string) => zonedInstant(date, time, TZ);

describe('fullWhen', () => {
  it.each([
    ['2026-11-04', '17:20', 'Wednesday, November 4, at 5:20 PM', 'el miércoles 4 de noviembre a las 5:20 de la tarde'],
    ['2026-11-04', '08:00', 'Wednesday, November 4, at 8:00 AM', 'el miércoles 4 de noviembre a las 8:00 de la mañana'],
    ['2026-11-05', '13:00', 'Thursday, November 5, at 1:00 PM', 'el jueves 5 de noviembre a la 1:00 de la tarde'],
    ['2026-11-05', '12:00', 'Thursday, November 5, at 12:00 PM', 'el jueves 5 de noviembre a las 12:00 del mediodía'],
    ['2026-11-05', '12:30', 'Thursday, November 5, at 12:30 PM', 'el jueves 5 de noviembre a las 12:30 de la tarde'],
    ['2026-11-05', '20:15', 'Thursday, November 5, at 8:15 PM', 'el jueves 5 de noviembre a las 8:15 de la noche'],
    ['2026-11-05', '01:00', 'Thursday, November 5, at 1:00 AM', 'el jueves 5 de noviembre a la 1:00 de la mañana'],
  ])('%s %s', (date, time, en, es) => {
    expect(PACKS.en.fullWhen(at(date, time), TZ)).toBe(en);
    expect(PACKS.es.fullWhen(at(date, time), TZ)).toBe(es);
  });

  it('is the clinic\'s day, not UTC\'s, late in the evening', () => {
    // 22:30 in Denver is the next day in UTC
    const late = new Date('2026-11-05T05:30:00Z');
    expect(PACKS.en.fullWhen(late, TZ)).toBe('Wednesday, November 4, at 10:30 PM');
  });

  it('follows the clock change week (Denver leaves daylight time on November 1, 2026)', () => {
    expect(PACKS.en.fullWhen(at('2026-10-31', '09:00'), TZ)).toBe('Saturday, October 31, at 9:00 AM');
    expect(PACKS.en.fullWhen(at('2026-11-02', '09:00'), TZ)).toBe('Monday, November 2, at 9:00 AM');
  });

  it('says a local date as a day', () => {
    expect(PACKS.en.fullDay('2026-11-11')).toBe('Wednesday, November 11');
    expect(PACKS.es.fullDay('2026-11-11')).toBe('miércoles 11 de noviembre');
  });

  it('asks which week once, in both languages', () => {
    expect(PACKS.en.whichWeek({ first: '2026-11-04', second: '2026-11-11' })).toBe('This Wednesday, November 4, or Wednesday, November 11?');
    expect(PACKS.es.whichWeek({ first: '2026-11-04', second: '2026-11-11' })).toBe('¿Este miércoles 4 de noviembre, o el miércoles 11 de noviembre?');
  });
});

const clinic = {
  timezone: TZ,
  providers: [
    { id: 'ruiz', name: 'Elena Ruiz', kind: 'person' as const },
    { id: 'patel', name: 'Raj Patel', kind: 'person' as const },
  ],
} as Parameters<typeof offerTimesLine>[1];
const slot = (providerId: string, date: string, time: string): Slot => ({ id: `${providerId}@${date}T${time}`, providerId, visitTypeId: 'vt', start: at(date, time), end: at(date, time) });

describe('offerTimes', () => {
  it('one day, one vet: the date and the vet once', () => {
    const slots = [slot('ruiz', '2026-11-04', '08:00'), slot('ruiz', '2026-11-04', '08:40'), slot('ruiz', '2026-11-04', '09:20')];
    expect(offerTimesLine(slots, clinic, 'en')).toBe('On Wednesday, November 4, I have 8:00, 8:40 or 9:20 AM with Dr. Elena Ruiz.');
    expect(offerTimesLine(slots, clinic, 'es')).toBe('El miércoles 4 de noviembre tengo a las 8:00, 8:40 o 9:20 de la mañana, con Dr. Elena Ruiz.');
  });

  it('two days', () => {
    const slots = [slot('ruiz', '2026-11-04', '08:00'), slot('ruiz', '2026-11-05', '09:20')];
    expect(offerTimesLine(slots, clinic, 'en')).toBe('On Wednesday, November 4, I have 8:00 AM, or on Thursday, November 5, 9:20 AM with Dr. Elena Ruiz.');
    expect(offerTimesLine(slots, clinic, 'es')).toBe('El miércoles 4 de noviembre tengo a las 8:00 de la mañana, o el jueves 5 de noviembre a las 9:20 de la mañana, con Dr. Elena Ruiz.');
  });

  it('several vets: each time with its vet', () => {
    const slots = [slot('ruiz', '2026-11-04', '08:00'), slot('patel', '2026-11-04', '08:40')];
    expect(offerTimesLine(slots, clinic, 'en')).toBe('On Wednesday, November 4, I have 8:00 AM with Dr. Elena Ruiz or 8:40 AM with Dr. Raj Patel.');
    expect(offerTimesLine(slots, clinic, 'es')).toBe('El miércoles 4 de noviembre tengo a las 8:00 de la mañana con Dr. Elena Ruiz o a las 8:40 de la mañana con Dr. Raj Patel.');
  });

  it('Spanish "o" is "u" before a time said with an o sound ("ocho", "once")', () => {
    const slots = [slot('ruiz', '2026-11-04', '07:20'), slot('ruiz', '2026-11-04', '08:00')];
    expect(offerTimesLine(slots, clinic, 'es')).toBe('El miércoles 4 de noviembre tengo a las 7:20 u 8:00 de la mañana, con Dr. Elena Ruiz.');
  });

  it('morning and afternoon on one day say each part', () => {
    const slots = [slot('ruiz', '2026-11-04', '11:20'), slot('ruiz', '2026-11-04', '14:00')];
    expect(offerTimesLine(slots, clinic, 'en')).toBe('On Wednesday, November 4, I have 11:20 AM or 2:00 PM with Dr. Elena Ruiz.');
    expect(offerTimesLine(slots, clinic, 'es')).toBe('El miércoles 4 de noviembre tengo a las 11:20 de la mañana o 2:00 de la tarde, con Dr. Elena Ruiz.');
  });

  it('groups by day in the order the days first come', () => {
    const slots = [slot('ruiz', '2026-11-05', '09:00'), slot('ruiz', '2026-11-04', '10:00'), slot('ruiz', '2026-11-05', '08:00')];
    expect(groupSlotsByDay(slots, TZ).map((d) => [d.date, d.slots.map((s) => s.id)])).toEqual([
      ['2026-11-05', ['ruiz@2026-11-05T08:00', 'ruiz@2026-11-05T09:00']],
      ['2026-11-04', ['ruiz@2026-11-04T10:00']],
    ]);
  });
});

describe('dayShift', () => {
  const was = at('2026-11-04', '17:20');
  it.each([
    ['2026-11-04', null, null],
    ['2026-11-05', "that's the next day, Thursday, November 5", 'es el día siguiente, el jueves 5 de noviembre'],
    ['2026-11-03', "that's the day before, Tuesday, November 3", 'es el día anterior, el martes 3 de noviembre'],
    ['2026-11-06', "that's two days later, Friday, November 6", 'es dos días después, el viernes 6 de noviembre'],
    ['2026-11-02', "that's two days earlier, Monday, November 2", 'es dos días antes, el lunes 2 de noviembre'],
    ['2026-11-11', "that's one week later, Wednesday, November 11", 'es una semana después, el miércoles 11 de noviembre'],
    ['2026-11-18', "that's two weeks later, Wednesday, November 18", 'es dos semanas después, el miércoles 18 de noviembre'],
    ['2026-11-13', "that's a different day, Friday, November 13", 'es otro día, el viernes 13 de noviembre'],
  ])('to %s', (date, en, es) => {
    expect(dayShift(was, at(date, '16:40'), TZ, 'en')).toBe(en);
    expect(dayShift(was, at(date, '16:40'), TZ, 'es')).toBe(es);
  });
});
