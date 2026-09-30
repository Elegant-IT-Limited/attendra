import { describe, expect, it } from 'vitest';
import { DEMO_CLINIC, findSlots, resolveTransfer, speakSlot, zonedInstant } from '../src';

const tz = DEMO_CLINIC.timezone;
const sick = DEMO_CLINIC.visitTypes.find((v) => v.id === 'vt_sick')!;
const okafor = DEMO_CLINIC.providers.filter((p) => p.id === 'prov_okafor');
const now = zonedInstant('2026-09-28', '20:00', tz); // Monday evening, after hours

describe('finding slots', () => {
  it('offers the three earliest free slots, in clinic time', () => {
    const slots = findSlots(DEMO_CLINIC, [], { visitType: sick, providers: okafor, from: '2026-09-29', days: 5, now });
    expect(slots.map((s) => speakSlot(s.start, tz))).toEqual([
      'Tuesday, September 29 at 8:00 AM', 'Tuesday, September 29 at 8:20 AM', 'Tuesday, September 29 at 8:40 AM',
    ]);
  });

  it('is earliest-first across 2 providers, with their order breaking a tie', () => {
    // Dr. Okafor is booked until 10:00; Dr. Lindqvist starts at 9:00 on Tuesdays
    const busy = [{ providerId: 'prov_okafor', start: zonedInstant('2026-09-29', '08:00', tz), end: zonedInstant('2026-09-29', '10:00', tz) }];
    const slots = findSlots(DEMO_CLINIC, busy, { visitType: sick, providers: DEMO_CLINIC.providers, from: '2026-09-29', days: 5, now, limit: 6 });
    expect(slots.map((s) => `${s.providerId} ${speakSlot(s.start, tz).replace('Tuesday, September 29 at ', '')}`)).toEqual([
      'prov_lindqvist 9:00 AM', 'prov_lindqvist 9:20 AM', 'prov_lindqvist 9:40 AM', 'prov_okafor 10:00 AM', 'prov_lindqvist 10:00 AM', 'prov_okafor 10:20 AM',
    ]);
  });

  it('skips booked time and respects afternoon-only requests', () => {
    const busy = [{ providerId: 'prov_okafor', start: zonedInstant('2026-09-29', '13:00', tz), end: zonedInstant('2026-09-29', '14:00', tz) }];
    const slots = findSlots(DEMO_CLINIC, busy, { visitType: sick, providers: okafor, from: '2026-09-29', days: 5, now, partOfDay: 'afternoon' });
    expect(speakSlot(slots[0]!.start, tz)).toBe('Tuesday, September 29 at 2:00 PM');
  });

  it('uses a provider\'s own hours and never offers a visit type they do not do', () => {
    const lindqvist = DEMO_CLINIC.providers.filter((p) => p.id === 'prov_lindqvist');
    const annual = DEMO_CLINIC.visitTypes.find((v) => v.id === 'vt_annual')!;
    const newPatient = DEMO_CLINIC.visitTypes.find((v) => v.id === 'vt_new')!;
    expect(speakSlot(findSlots(DEMO_CLINIC, [], { visitType: annual, providers: lindqvist, from: '2026-09-29', days: 5, now })[0]!.start, tz))
      .toBe('Tuesday, September 29 at 9:00 AM');
    expect(findSlots(DEMO_CLINIC, [], { visitType: newPatient, providers: lindqvist, from: '2026-09-29', days: 14, now })).toEqual([]);
  });

  it('keeps a lead time so the front desk is not surprised by a booking an hour away', () => {
    const morning = zonedInstant('2026-09-29', '08:05', tz);
    const slots = findSlots(DEMO_CLINIC, [], { visitType: sick, providers: okafor, from: '2026-09-29', days: 1, now: morning });
    expect(speakSlot(slots[0]!.start, tz)).toBe('Tuesday, September 29 at 10:20 AM');
  });
});

describe('transfers', () => {
  it('sends the front desk line during hours and the on-call line after', () => {
    expect(resolveTransfer(DEMO_CLINIC, 'front_desk', zonedInstant('2026-09-29', '10:00', tz))).toEqual({ ok: true, uri: 'tel:+13035550101' });
    expect(resolveTransfer(DEMO_CLINIC, 'front_desk', now)).toEqual({ ok: false, reason: 'closed' });
    expect(resolveTransfer(DEMO_CLINIC, 'on_call', now)).toEqual({ ok: true, uri: 'tel:+13035550199' });
  });
});
