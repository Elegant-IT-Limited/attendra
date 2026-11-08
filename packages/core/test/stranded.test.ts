import { describe, expect, it } from 'vitest';
import { DEMO_CLINIC, newlyStranded, strandedReason, zonedInstant } from '../src';

const tz = DEMO_CLINIC.timezone;
// the demo's holidays follow the current year; fixed here so the dates below never meet one
const clinic = { ...DEMO_CLINIC, holidays: [] as string[] };
const okafor = clinic.providers.find((p) => p.id === 'prov_okafor')!; // the clinic's hours: weekdays 8-12, 1-5 (Friday 8-1)
const lindqvist = clinic.providers.find((p) => p.id === 'prov_lindqvist')!; // her own: Tuesday and Thursday 9-3
const visit = (id: string, providerId: string, date: string, time: string, minutes = 20) => {
  const start = zonedInstant(date, time, tz);
  return { id, providerId, start, end: new Date(start.getTime() + minutes * 60_000) };
};
const TUE = '2026-10-06';

describe('a booked visit stranded by a change of hours (SCH-4)', () => {
  it('fits while it sits inside its vet\'s bookable hours, whole', () => {
    expect(strandedReason(clinic, okafor, visit('a', 'prov_okafor', TUE, '16:40'))).toBeNull();
    expect(strandedReason(clinic, lindqvist, visit('b', 'prov_lindqvist', TUE, '14:40'))).toBeNull();
  });

  it('is outside the hours when the clinic\'s hours are cut, or a vet\'s own', () => {
    const shorter = { ...clinic, hours: { ...clinic.hours, 2: [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '16:00' }] } };
    expect(strandedReason(shorter, okafor, visit('a', 'prov_okafor', TUE, '16:40'))).toBe('outside_hours');
    // ending at the new close still fits
    expect(strandedReason(shorter, okafor, visit('a', 'prov_okafor', TUE, '15:40'))).toBeNull();
    // a vet with hours of their own is not moved by the clinic's
    expect(strandedReason(shorter, lindqvist, visit('b', 'prov_lindqvist', TUE, '14:40'))).toBeNull();
    const cut = { ...lindqvist, hours: { 2: [{ open: '09:00', close: '12:00' }] } };
    expect(strandedReason(clinic, cut, visit('b', 'prov_lindqvist', TUE, '14:40'))).toBe('outside_hours');
    // a visit that now runs past the close is stranded too: the visit must fit, not only start
    expect(strandedReason(clinic, cut, visit('c', 'prov_lindqvist', TUE, '11:50'))).toBe('outside_hours');
  });

  it('is on a holiday, or on a special day whose hours no longer hold it, except for a vet the special day lists', () => {
    expect(strandedReason({ ...clinic, holidays: [TUE] }, okafor, visit('a', 'prov_okafor', TUE, '09:00'))).toBe('holiday');
    const half = { ...clinic, specialDays: [{ date: TUE, windows: [{ open: '08:00', close: '12:00' }] }] };
    expect(strandedReason(half, okafor, visit('a', 'prov_okafor', TUE, '15:00'))).toBe('holiday');
    expect(strandedReason(half, okafor, visit('a', 'prov_okafor', TUE, '09:00'))).toBeNull();
    const listed = { ...clinic, specialDays: [{ date: TUE, windows: [], providerIds: ['prov_lindqvist'] }] };
    expect(strandedReason(listed, lindqvist, visit('b', 'prov_lindqvist', TUE, '10:00'))).toBeNull();
    expect(strandedReason(listed, okafor, visit('a', 'prov_okafor', TUE, '10:00'))).toBe('holiday');
  });

  it('is away when the vet is off all day or for a part that overlaps it', () => {
    expect(strandedReason(clinic, { ...okafor, timeOff: [{ from: TUE, to: TUE }] }, visit('a', 'prov_okafor', TUE, '09:00'))).toBe('away');
    const part = { ...okafor, timeOff: [{ from: TUE, to: TUE, start: '09:10', end: '10:00' }] };
    expect(strandedReason(clinic, part, visit('a', 'prov_okafor', TUE, '09:00'))).toBe('away');
    expect(strandedReason(clinic, part, visit('a', 'prov_okafor', TUE, '10:00'))).toBeNull();
  });

  it('a visit whose vet is no longer listed is judged by the clinic\'s days only', () => {
    expect(strandedReason(clinic, undefined, visit('a', 'prov_gone', TUE, '03:00'))).toBeNull();
    expect(strandedReason({ ...clinic, holidays: [TUE] }, undefined, visit('a', 'prov_gone', TUE, '09:00'))).toBe('holiday');
  });

  it('a change lists only the visits it strands, not ones already outside (squeezed in, or kept before)', () => {
    const visits = [visit('in', 'prov_okafor', TUE, '16:40'), visit('early', 'prov_okafor', TUE, '07:00'), visit('fine', 'prov_okafor', TUE, '09:00'), visit('her', 'prov_lindqvist', TUE, '14:40')];
    const after = { ...clinic, hours: { ...clinic.hours, 2: [{ open: '08:00', close: '12:00' }] } };
    expect(newlyStranded(clinic, after, visits).map((v) => [v.id, v.reason])).toEqual([['in', 'outside_hours']]);
    expect(newlyStranded(clinic, clinic, visits)).toEqual([]);
    // a time zone corrected alone is not asked about (the Schedule's warning still counts what it leaves outside)
    expect(newlyStranded(clinic, { ...clinic, timezone: 'Europe/Madrid' }, visits)).toEqual([]);
    expect(newlyStranded(clinic, { ...after, timezone: 'Europe/Madrid' }, visits).map((v) => v.id)).toEqual(['in']);
  });
});
