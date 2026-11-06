import { describe, expect, it } from 'vitest';
import { ClinicConfig, clinicNow, clinicNowLine, DEMO_CLINIC, zonedInstant } from '../src';

const at = (date: string, time: string, tz = DEMO_CLINIC.timezone) => zonedInstant(date, time, tz);

describe('clinic_now: the clinic\'s clock, from one place', () => {
  it('is open mid-morning, with the closing time of the window it is in', () => {
    const now = clinicNow(DEMO_CLINIC, at('2026-09-29', '10:15'));
    expect(now).toMatchObject({ date: '2026-09-29', weekday: 2, time: '10:15', open: true, closesAt: '12:00', opensNext: null, partOfDay: 'morning', visitsNow: 'book' });
    expect(now.zoneName).toBe('MDT');
  });

  it('is closed over lunch and says when it opens again the same day', () => {
    expect(clinicNow(DEMO_CLINIC, at('2026-09-29', '12:30'))).toMatchObject({ open: false, opensNext: { date: '2026-09-29', time: '13:00' }, partOfDay: 'afternoon' });
  });

  it('early in the morning at a clinic that books after hours: closed, and a visit is still booked now', () => {
    // a test call at 7:25 AM was refused a booking by a voice prompt written when the clinic was closed (2026-11)
    const now = clinicNow({ ...DEMO_CLINIC, afterHours: 'book' }, at('2026-09-29', '07:25'));
    expect(now).toMatchObject({ open: false, opensNext: { date: '2026-09-29', time: '08:00' }, visitsNow: 'book', partOfDay: 'morning' });
    expect(clinicNowLine(DEMO_CLINIC, now, 'en')).toBe('It\'s 7:25 AM on Tuesday, September 29, clinic time (MDT). The clinic is closed; it opens at 8:00 AM. Visits can still be booked on this call now.');
  });

  it('a clinic that takes requests after hours: a request now, never a booking', () => {
    const clinic = ClinicConfig.parse({ ...DEMO_CLINIC, afterHours: 'requests' });
    const now = clinicNow(clinic, at('2026-09-29', '19:40'));
    expect(now).toMatchObject({ open: false, visitsNow: 'request', partOfDay: 'evening', opensNext: { date: '2026-09-30', time: '08:00' } });
    expect(clinicNowLine(clinic, now, 'en')).toContain('Visits are not booked right now');
    expect(clinicNowLine(clinic, now, 'es')).toContain('Ahora no se reservan citas');
  });

  it('skips the weekend and a holiday to the next opening', () => {
    // Saturday 2026-11-28 is after the demo's Thanksgiving; Monday opens at 8
    expect(clinicNow(DEMO_CLINIC, at('2026-11-28', '10:00'))).toMatchObject({ open: false, opensNext: { date: '2026-11-30', time: '08:00' } });
    expect(clinicNow(DEMO_CLINIC, at('2026-11-26', '10:00'))).toMatchObject({ open: false, holiday: true, opensNext: { date: '2026-11-27', time: '08:00' } });
  });

  it('reads each clinic in its own zone', () => {
    const ny = ClinicConfig.parse({ ...DEMO_CLINIC, timezone: 'America/New_York' });
    const instant = new Date('2026-11-06T12:25:00Z');
    expect(clinicNow(ny, instant)).toMatchObject({ time: '07:25', zoneName: 'EST' });
    expect(clinicNow(DEMO_CLINIC, instant)).toMatchObject({ time: '05:25', zoneName: 'MST' });
  });

  it('says it in Spanish too', () => {
    const now = clinicNow(DEMO_CLINIC, at('2026-09-29', '10:15'));
    expect(clinicNowLine(DEMO_CLINIC, now, 'es')).toMatch(/^Son las 10:15 a\.\s?m\. del martes, 29 de septiembre, hora de la clínica \(MDT\)\. La clínica está abierta hasta las 12:00 p\.\s?m\.$/u);
    expect(clinicNowLine(DEMO_CLINIC, clinicNow(DEMO_CLINIC, at('2026-11-28', '10:00')), 'en')).toContain('it opens at 8:00 AM on Monday, November 30.');
  });
});
