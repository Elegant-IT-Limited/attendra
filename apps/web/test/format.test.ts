import { afterEach, describe, expect, it } from 'vitest';
import { age, ago, clinicTime, setClinicCountry, tenDigitPhones, timeOf, usd } from '../lib/format';

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
