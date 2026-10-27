import { afterEach, describe, expect, it } from 'vitest';
import { age, ago, clinicTime, NEW_MEMBER, personName, phone, setClinicCountry, telHref, tenDigitPhones, timeOf, usd } from '../lib/format';

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
    for (const typed of ['+15055550142', '5055550142', '505-555-0142', '(505) 555 0142', '1 505 555 0142', '505.555.0142']) {
      expect([phone(typed), telHref(typed)]).toEqual(['(505) 555-0142', 'tel:+15055550142']);
    }
    // a partial number, or one from abroad, as it was given
    expect([phone('555 0142'), telHref('555 0142')]).toEqual(['555 0142', 'tel:5550142']);
    expect([phone('+442079460123'), telHref('+44 20 7946 0123')]).toEqual(['+442079460123', 'tel:+442079460123']);
    expect(phone(null)).toBe('');
  });

  it('leaves ten digits alone at a clinic outside North America', () => {
    setClinicCountry(['+442079460123']);
    expect(phone('5055550142')).toBe('5055550142');
    expect(phone('+15055550142')).toBe('(505) 555-0142');
  });
});

describe('a team member\'s name as it shows', () => {
  it('reads "New team member" until they write one, and is otherwise theirs', () => {
    expect(personName('')).toBe(NEW_MEMBER);
    expect(personName('   ')).toBe('New team member');
    expect(personName('Kit Rowan')).toBe('Kit Rowan');
  });
});
