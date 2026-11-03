import { describe, expect, it } from 'vitest';
import { BOOKING_LEAD_MINUTES, bookableWindows, ClinicConfig, findSlots, gridStarts, type Provider, START_EVERY_CHOICES, zonedInstant } from '../src';

// Made-up clinic (2026-11-15): the front desk is open Monday to Friday 7:30 to 5, in Chicago. Dr. Marlow keeps her own
// hours (Sunday 9 to 1, Friday 9 to 1 and 2 to 6), Dr. Hartley is in until 7 on weekdays, Dr. Nolan has the clinic's.
const tz = 'America/Chicago';
const DESK = [{ open: '07:30', close: '17:00' }];
const clinic = ClinicConfig.parse({
  id: 'clinic_test_grid', name: 'Test Animal Clinic', industry: 'vet', timezone: tz, phoneNumbers: ['+13125550100'],
  hours: { 1: DESK, 2: DESK, 3: DESK, 4: DESK, 5: DESK },
  holidays: ['2026-11-26'],
  greeting: 'Thanks for calling Test Animal Clinic, this is the clinic\'s AI assistant. How can I help?',
  providers: [
    { id: 'prov_marlow', name: 'Dr. Sofia Marlow', gender: 'female', visitTypeIds: ['vt_surgery', 'vt_consult', 'vt_exam'],
      hours: { 0: [{ open: '09:00', close: '13:00' }], 5: [{ open: '09:00', close: '13:00' }, { open: '14:00', close: '18:00' }] } },
    { id: 'prov_hartley', name: 'Dr. Ben Hartley', gender: 'male', visitTypeIds: ['vt_exam', 'vt_dental', 'vt_vaccine'],
      hours: { 1: [{ open: '08:00', close: '19:00' }], 2: [{ open: '08:00', close: '19:00' }], 3: [{ open: '08:00', close: '19:00' }], 4: [{ open: '08:00', close: '19:00' }], 5: [{ open: '08:00', close: '19:00' }] } },
    { id: 'prov_nolan', name: 'Dr. Kira Nolan', gender: 'female', visitTypeIds: ['vt_exam', 'vt_dental', 'vt_vaccine'] },
  ],
  visitTypes: [
    { id: 'vt_exam', name: 'exam', minutes: 20 },
    { id: 'vt_dental', name: 'dental care', minutes: 30 },
    { id: 'vt_vaccine', name: 'vaccine visit', minutes: 10 },
    { id: 'vt_surgery', name: 'surgery', minutes: 60 },
    { id: 'vt_consult', name: 'surgery consultation', minutes: 30, bufferMinutes: 10 },
  ],
});
const vt = (id: string) => clinic.visitTypes.find((v) => v.id === id)!;
const vet = (id: string) => clinic.providers.find((p) => p.id === id)! as Provider;
// Wednesday, November 4, 2026, 7 AM
const now = zonedInstant('2026-11-04', '07:00', tz);
const hm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const times = (slots: { start: Date }[]) => slots.map((s) => hm(s.start));

describe('a vet\'s own hours decide (item 1)', () => {
  it('a Sunday-only vet is booked on Sunday, while the clinic is closed, and the slot says so', () => {
    const slots = findSlots(clinic, [], { visitType: vt('vt_exam'), providers: [vet('prov_marlow')], from: '2026-11-08', days: 1, now });
    expect(times(slots)).toEqual(['Sun 09:00', 'Sun 09:20', 'Sun 09:40']);
    expect(slots.every((s) => s.outsideClinicHours)).toBe(true);
    // a vet with the clinic's hours has nothing on a Sunday
    expect(findSlots(clinic, [], { visitType: vt('vt_exam'), providers: [vet('prov_nolan')], from: '2026-11-08', days: 1, now })).toEqual([]);
  });

  it('a vet in until 7 at a clinic that closes at 5 is booked after 5, marked outside the clinic\'s hours', () => {
    const slots = findSlots(clinic, [], { visitType: vt('vt_exam'), providers: [vet('prov_hartley')], from: '2026-11-05', days: 1, now, limit: 100, allStarts: true });
    const late = slots.find((s) => hm(s.start) === 'Thu 18:40')!;
    expect(late.outsideClinicHours).toBe(true);
    expect(slots.find((s) => hm(s.start) === 'Thu 16:40')!.outsideClinicHours).toBe(false);
    expect(times(slots).at(-1)).toBe('Thu 18:40');
  });

  it('a holiday closes the clinic for everyone, own hours or not', () => {
    expect(bookableWindows(clinic, vet('prov_hartley'), '2026-11-26').windows).toEqual([]);
    expect(findSlots(clinic, [], { visitType: vt('vt_exam'), providers: [vet('prov_hartley'), vet('prov_nolan')], from: '2026-11-26', days: 1, now })).toEqual([]);
  });

  it('a special day closes it too, except for a vet it lists, who keeps their own hours', () => {
    const closed = { ...clinic, specialDays: [{ date: '2026-11-06', windows: [], note: 'staff training' }] };
    expect(bookableWindows(closed, vet('prov_marlow'), '2026-11-06').windows).toEqual([]);
    const listed = { ...clinic, specialDays: [{ date: '2026-11-06', windows: [], note: 'staff training', providerIds: ['prov_marlow'] }] };
    expect(bookableWindows(listed, vet('prov_marlow'), '2026-11-06').windows).toEqual([{ open: '09:00', close: '13:00' }, { open: '14:00', close: '18:00' }]);
    expect(bookableWindows(listed, vet('prov_nolan'), '2026-11-06').windows).toEqual([]);
    // shorter hours: everyone inside them, a vet with their own hours where both overlap
    const half = { ...clinic, specialDays: [{ date: '2026-11-06', windows: [{ open: '08:00', close: '12:00' }] }] };
    expect(bookableWindows(half, vet('prov_nolan'), '2026-11-06').windows).toEqual([{ open: '08:00', close: '12:00' }]);
    expect(bookableWindows(half, vet('prov_marlow'), '2026-11-06').windows).toEqual([{ open: '09:00', close: '12:00' }]);
  });

  it('the clinic\'s hours are for a vet with none of their own', () => {
    expect(bookableWindows(clinic, vet('prov_nolan'), '2026-11-05')).toEqual({ windows: DESK, clinicWindows: DESK });
  });
});

describe('start times on the clinic\'s grid (item 2)', () => {
  const thursday = { providers: [vet('prov_hartley')], from: '2026-11-05', days: 1, now, limit: 500, allStarts: true };
  it('5, 10 and 15 minutes', () => {
    expect(times(findSlots(clinic, [], { ...thursday, visitType: vt('vt_exam'), startEvery: 5 })).slice(0, 4)).toEqual(['Thu 08:00', 'Thu 08:05', 'Thu 08:10', 'Thu 08:15']);
    expect(times(findSlots(clinic, [], { ...thursday, visitType: vt('vt_exam'), startEvery: 10 })).slice(0, 4)).toEqual(['Thu 08:00', 'Thu 08:10', 'Thu 08:20', 'Thu 08:30']);
    expect(times(findSlots(clinic, [], { ...thursday, visitType: vt('vt_exam'), startEvery: 15 })).slice(0, 4)).toEqual(['Thu 08:00', 'Thu 08:15', 'Thu 08:30', 'Thu 08:45']);
    // the clinic's own setting, 10 by default
    expect(times(findSlots({ ...clinic, booking: { ...clinic.booking, startEvery: 15 } as never }, [], { ...thursday, visitType: vt('vt_exam') })).slice(0, 2)).toEqual(['Thu 08:00', 'Thu 08:15']);
    expect(START_EVERY_CHOICES).toEqual([5, 10, 15, 20, 30]);
  });

  it('a 20-minute visit can start at 8:30 (a tester call: "isn\'t available at 8:30")', () => {
    expect(times(findSlots(clinic, [], { ...thursday, visitType: vt('vt_exam') }))).toContain('Thu 08:30');
  });

  it('a window opening off the grid starts there, then on the clock', () => {
    expect(gridStarts(8 * 60 + 5, 9 * 60, 20, 10).map((m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`)).toEqual(['8:05', '8:10', '8:20', '8:30', '8:40']);
  });

  it('a visit and its buffer fit inside the window: the last start moves earlier', () => {
    // Friday 2 to 6: a 30-minute consultation keeps 10 minutes after it, so 5:20 is the last start, not 5:30
    const fri = findSlots(clinic, [], { visitType: vt('vt_consult'), providers: [vet('prov_marlow')], from: '2026-11-06', days: 1, now, limit: 500, allStarts: true });
    expect(times(fri).at(-1)).toBe('Fri 17:20');
    // and the window end: a 20-minute visit at a clinic that closes at 5 starts 4:40 at the latest
    expect(times(findSlots(clinic, [], { visitType: vt('vt_exam'), providers: [vet('prov_nolan')], from: '2026-11-05', days: 1, now, limit: 500, allStarts: true })).at(-1)).toBe('Thu 16:40');
  });

  it('a booked visit\'s buffer is kept: the next start is the first grid time after it', () => {
    const busy = [{ providerId: 'prov_marlow', start: zonedInstant('2026-11-06', '09:00', tz), end: zonedInstant('2026-11-06', '09:30', tz), visitTypeId: 'vt_consult' }];
    const slots = findSlots(clinic, busy, { visitType: vt('vt_exam'), providers: [vet('prov_marlow')], from: '2026-11-06', days: 1, now, limit: 1 });
    expect(times(slots)).toEqual(['Fri 09:40']);
  });

  it('the times offered are a visit apart, while every grid start stays bookable', () => {
    expect(times(findSlots(clinic, [], { ...thursday, visitType: vt('vt_exam'), allStarts: false, limit: 3 }))).toEqual(['Thu 08:00', 'Thu 08:20', 'Thu 08:40']);
  });

  it('nothing sooner than the lead time, two hours by default', () => {
    expect(BOOKING_LEAD_MINUTES).toBe(120);
    const at9 = zonedInstant('2026-11-05', '09:03', tz);
    expect(times(findSlots(clinic, [], { visitType: vt('vt_exam'), providers: [vet('prov_hartley')], from: '2026-11-05', days: 1, now: at9, limit: 1 }))).toEqual(['Thu 11:10']);
  });
});

describe('the nearest times to the one asked for (item 3)', () => {
  // Dr. Nolan's 4:00 is taken on Thursday: a 10-minute visit is free at 3:50 and 4:20
  const busy = [{ providerId: 'prov_nolan', start: zonedInstant('2026-11-05', '16:00', tz), end: zonedInstant('2026-11-05', '16:20', tz) }];
  const q = { visitType: vt('vt_vaccine'), providers: [vet('prov_nolan')], from: '2026-11-05', days: 60, now };
  it('around: "not at 4, but 3:50 or 4:20"', () => {
    expect(times(findSlots(clinic, busy, { ...q, near: { date: '2026-11-05', time: '16:00', direction: 'around' }, limit: 2 }))).toEqual(['Thu 15:50', 'Thu 16:20']);
  });
  it('the exact time first when it is free', () => {
    expect(times(findSlots(clinic, busy, { ...q, near: { date: '2026-11-05', time: '15:00', direction: 'around' }, limit: 3 }))[0]).toBe('Thu 15:00');
  });
  it('before: "earlier than 6" is the latest times before 6, not the morning', () => {
    expect(times(findSlots(clinic, busy, { ...q, near: { date: '2026-11-05', time: '18:00', direction: 'before' }, limit: 2 }))).toEqual(['Thu 16:50', 'Thu 16:40']);
  });
  it('after: "after 3" is 3:00 on', () => {
    expect(times(findSlots(clinic, busy, { ...q, near: { date: '2026-11-05', time: '15:00', direction: 'after' }, limit: 2 }))).toEqual(['Thu 15:00', 'Thu 15:10']);
  });
  it('none that day: the same time on the next working days, one a day', () => {
    const full = [{ providerId: 'prov_nolan', start: zonedInstant('2026-11-05', '07:00', tz), end: zonedInstant('2026-11-05', '18:00', tz) }];
    expect(times(findSlots(clinic, full, { ...q, near: { date: '2026-11-05', time: '16:00', direction: 'around' }, limit: 2 }))).toEqual(['Fri 16:00', 'Mon 16:00']);
  });
  it('a time outside the vet\'s hours gets the nearest inside them', () => {
    // Dr. Marlow starts at 9 on Fridays: asked for 8, the nearest is 9:00
    const slots = findSlots(clinic, [], { visitType: vt('vt_exam'), providers: [vet('prov_marlow')], from: '2026-11-06', days: 60, now, near: { date: '2026-11-06', time: '08:00', direction: 'around' }, limit: 1 });
    expect(times(slots)).toEqual(['Fri 09:00']);
  });
});
