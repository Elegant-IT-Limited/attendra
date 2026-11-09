import { afterEach, describe, expect, it } from 'vitest';
import { weeklyHoursLine } from '@attendra/core';
import { age, ago, clinicTime, firstWeekday, hourMark, localTime, NEW_MEMBER, personName, phone, setClinicCountry, telHref, tenDigitPhones, timeOf, usd, visitTypeName, weekdayHeads } from '../lib/format';

afterEach(() => setClinicCountry(['+13035550100']));

describe('formatting that follows the clinic\'s country', () => {
  it('keeps the 12-hour clock, dollars and ten-digit numbers in North America', () => {
    setClinicCountry(['+13035550100']);
    expect(timeOf('2026-09-29T21:00:00Z', 'America/Denver')).toBe('3:00 PM');
    expect(usd(0.05)).toBe('$0.05');
    expect(tenDigitPhones()).toBe(true);
  });

  it('uses a 24-hour clock and says US dollars at a clinic in the United Kingdom', () => {
    setClinicCountry(['+442079460123']);
    expect(timeOf('2026-09-29T14:00:00Z', 'Europe/London')).toBe('15:00');
    expect(clinicTime('2026-09-29T14:00:00Z', 'Europe/London')).toBe('Tue 29 Sep 15:00');
    expect(usd(0.05)).toBe('US$0.05');
    expect(tenDigitPhones()).toBe(false);
  });

  it('keeps the 12-hour clock in Australia', () => {
    setClinicCountry(['+61491570123']);
    expect(timeOf('2026-09-29T05:00:00Z', 'Australia/Sydney')).toBe('3:00 PM');
  });
});

describe('age', () => {
  it('counts whole years on the clinic\'s date, so a birthday turns over at the clinic\'s midnight', () => {
    expect(age('2000-09-30', '2026-09-29')).toBe(25);
    expect(age('2000-09-30', '2026-09-30')).toBe(26);
    expect(age('2000-02-29', '2026-02-28')).toBe(25);
  });
});

describe('how long ago', () => {
  it('writes the unit in full, singular for one', () => {
    const min = 60_000;
    expect(ago(20_000)).toBe('just now');
    expect(ago(min)).toBe('1 minute ago');
    expect(ago(12 * min)).toBe('12 minutes ago');
    expect(ago(60 * min)).toBe('1 hour ago');
    expect(ago(7 * 60 * min)).toBe('7 hours ago');
    expect(ago(24 * 60 * min)).toBe('1 day ago');
    expect(ago(11 * 24 * 60 * min)).toBe('11 days ago');
  });
});

describe('phone numbers', () => {
  it('reads a number the way people write it, however it was typed, with a link that calls it', () => {
    setClinicCountry(['+13035550100']);
    for (const typed of ['+15055550142', '5055550142', '505-555-0142', '(505) 555 0142', '1 505 555 0142', '505.555.0142', '+1 505 555 0142', '001 505 555 0142']) {
      expect([phone(typed), telHref(typed)]).toEqual(['(505) 555-0142', 'tel:+15055550142']);
    }
    // a partial number as it was given; one from abroad in the international format
    expect([phone('555 0142'), telHref('555 0142')]).toEqual(['555 0142', 'tel:5550142']);
    expect([phone('+442079460123'), telHref('+44 20 7946 0123')]).toEqual(['+44 20 7946 0123', 'tel:+442079460123']);
    expect(phone(null)).toBe('');
  });

  it('reads a number in the clinic\'s own national format outside North America, and others internationally', () => {
    setClinicCountry(['+442079460123']);
    expect([phone('+442079460123'), phone('020 7946 0123'), telHref('020 7946 0123')]).toEqual(['020 7946 0123', '020 7946 0123', 'tel:+442079460123']);
    expect(phone('+447700900123')).toBe('07700 900123');
    expect(phone('+15055550142')).toBe('+1 505 555 0142');
    setClinicCountry(['+13035550100']);
  });
});

describe('a team member\'s name as it shows', () => {
  it('reads "New team member" until they write one, and is otherwise theirs', () => {
    expect(personName('')).toBe(NEW_MEMBER);
    expect(personName('   ')).toBe('New team member');
    expect(personName('Kit Rowan')).toBe('Kit Rowan');
  });
});

describe('local times (hours, time off) on the clinic\'s clock', () => {
  it('writes HH:MM as 12-hour at a US clinic and 24-hour in the United Kingdom, like every other time', () => {
    setClinicCountry(['+15055550142']);
    // the same clock as a timestamp: 14:00 UTC is 8:00 AM in Denver
    expect(localTime('08:00')).toBe(timeOf('2026-09-29T14:00:00Z', 'America/Denver'));
    expect(localTime('08:00')).toBe('8:00 AM');
    expect(localTime('18:30')).toBe('6:30 PM');
    expect(localTime('12:00')).toBe('12:00 PM');
    expect(localTime('24:00')).toBe('12:00 AM');
    expect(hourMark(8 * 60)).toBe('8 AM');
    expect(hourMark(13 * 60)).toBe('1 PM');
    expect(weeklyHoursLine({ '1': [{ open: '08:00', close: '18:00' }] }, localTime)).toBe('Mon 8:00 AM-6:00 PM');
    setClinicCountry(['+442079460123']);
    expect(localTime('08:00')).toBe('08:00');
    expect(localTime('18:30')).toBe('18:30');
    expect(hourMark(8 * 60)).toBe('08:00');
    expect(weeklyHoursLine({ '1': [{ open: '08:00', close: '18:00' }] }, localTime)).toBe('Mon 08:00-18:00');
  });

  it('leaves the assistant\'s hours line as stored when no clock is given', () => {
    expect(weeklyHoursLine({ '1': [{ open: '08:00', close: '18:00' }] })).toBe('Mon 08:00-18:00');
  });
});

describe('a visit type\'s name as a label', () => {
  it('is sentence case wherever it stands alone, whatever the clinic typed', () => {
    expect(visitTypeName('wellness exam')).toBe('Wellness exam');
    expect(visitTypeName('Dental cleaning')).toBe('Dental cleaning');
    expect(visitTypeName('X-ray')).toBe('X-ray');
    expect(visitTypeName('')).toBe('');
  });
});

describe('the first day of the week', () => {
  it('is Sunday at a North American clinic and Monday elsewhere', () => {
    setClinicCountry(['+13035550100']);
    expect(firstWeekday()).toBe(0);
    expect(weekdayHeads()).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    setClinicCountry(['+442079460123']);
    expect(firstWeekday()).toBe(1);
    expect(weekdayHeads()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });
});
