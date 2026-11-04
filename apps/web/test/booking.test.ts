import { bookingOf, ClinicConfig, DESK_LEAD_MINUTES, RIVERBEND_CLINIC } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { gridLabel, upcomingSlots, vetChoices } from '../lib/booking';
import { outsideDesk } from '../lib/schedule-lanes';

describe('the New booking dialog (2026-11-15)', () => {
  it('at 10:00, hides 10:00 and 10:04 and shows 10:10: the desk\'s lead as the server sends it', () => {
    // 10:00 AM in Denver. 10:04 is a real start when a vet's hours open at 10:04 (a window's opening is always a start,
    // then the grid): it begins in under the desk's 5 minutes, so it is hidden like 10:00 itself
    const now = new Date('2026-11-04T17:00:00Z');
    const at = (minutes: number) => ({ startsAt: new Date(now.getTime() + minutes * 60_000).toISOString() });
    const server = { leadMinutes: DESK_LEAD_MINUTES };
    expect(upcomingSlots([at(-20), at(0), at(4), at(10), at(20)], now, server.leadMinutes)).toEqual([at(10), at(20)]);
    // a list loaded at 9:50 that still holds 10:00 shows it no more at 10:00 (the 10:00 AM offered at 10:20)
    expect(upcomingSlots([at(0)], now, server.leadMinutes)).toEqual([]);
  });

  it('says the grid and the lead the server used, word for word', () => {
    const server = { startEvery: bookingOf(RIVERBEND_CLINIC).startEvery, leadMinutes: DESK_LEAD_MINUTES };
    expect(gridLabel(server.startEvery, server.leadMinutes)).toBe(`Start times every ${server.startEvery} minutes. Times starting in the next ${DESK_LEAD_MINUTES} minutes are not shown; for one sooner, use Override.`);
    const fifteen = bookingOf(ClinicConfig.parse({ ...RIVERBEND_CLINIC, booking: { startEvery: 15 } })).startEvery;
    expect(gridLabel(fifteen, server.leadMinutes)).toContain(`every ${fifteen} minutes`);
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
