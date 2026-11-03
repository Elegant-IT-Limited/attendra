import { BOOKING_LEAD_MINUTES, bookingOf, ClinicConfig, RIVERBEND_CLINIC } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { gridLabel, upcomingSlots, vetChoices } from '../lib/booking';
import { outsideDesk } from '../lib/schedule-lanes';

describe('the New booking dialog (2026-11-15)', () => {
  it('hides times sooner than the lead time, the assistant\'s two hours, however long ago the list loaded', () => {
    const now = new Date('2026-11-04T16:00:00Z');
    const at = (minutes: number) => ({ startsAt: new Date(now.getTime() + minutes * 60_000).toISOString() });
    // the 10:00 AM offered at 10:20 (call 8.5): a time already past is never shown
    expect(upcomingSlots([at(-20), at(30), at(119), at(120), at(180)], now)).toEqual([at(120), at(180)]);
    expect(BOOKING_LEAD_MINUTES).toBe(120);
    // the server's own lead wins when it sends one
    expect(upcomingSlots([at(10), at(30)], now, 15)).toEqual([at(30)]);
  });

  it('says the grid and the lead the server used, word for word', () => {
    const server = { startEvery: bookingOf(RIVERBEND_CLINIC).startEvery, leadMinutes: BOOKING_LEAD_MINUTES };
    expect(gridLabel(server.startEvery, server.leadMinutes)).toBe('Start times every 10 minutes, from 2 hours from now. For a walk-in sooner than that, use Override.');
    const fifteen = bookingOf(ClinicConfig.parse({ ...RIVERBEND_CLINIC, booking: { startEvery: 15 } })).startEvery;
    expect(gridLabel(fifteen)).toContain(`every ${fifteen} minutes`);
  });

  it('lists every vet, greying out with why those who do not do the visit', () => {
    const choices = vetChoices(RIVERBEND_CLINIC, 'vt_vaccines');
    expect(choices.find((c) => c.id === 'prov_ruiz')).toEqual({ id: 'prov_ruiz', label: 'Dr. Elena Ruiz', disabled: false });
    expect(choices.find((c) => c.id === 'prov_sato')).toEqual({ id: 'prov_sato', label: 'Dr. Hana Sato (doesn\'t do vaccine appointment)', disabled: true });
  });
});

describe('the schedule grid', () => {
  it('marks a vet\'s open time while the front desk is closed', () => {
    // a vet in 8 to 7 at a desk open 8 to 5: 5 to 7 is open to book, with the desk closed
    expect(outsideDesk([[480, 1140]], [[480, 1020]])).toEqual([[1020, 1140]]);
    // a Sunday vet with the desk closed all day
    expect(outsideDesk([[540, 780]], [])).toEqual([[540, 780]]);
    expect(outsideDesk([[540, 780]], [[480, 1020]])).toEqual([]);
  });
});
