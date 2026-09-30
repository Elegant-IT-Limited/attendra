import { afterEach, describe, expect, it } from 'vitest';
import { age, clinicTime, setClinicCountry, tenDigitPhones, timeOf, usd } from '../lib/format';

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
