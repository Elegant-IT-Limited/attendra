// SPDX-License-Identifier: AGPL-3.0-only
import { BOOKING_LEAD_MINUTES, type ClinicConfig, providerName, shownProviders } from '@attendra/core';

/**
 * The New booking dialog's vet list for one visit type: everyone listed, those who do not do it greyed out with why,
 * so the desk never picks a vet the booking would refuse (2026-11-15).
 */
export function vetChoices(clinic: Pick<ClinicConfig, 'providers' | 'visitTypes'>, visitTypeId: string): { id: string; label: string; disabled: boolean }[] {
  const visit = clinic.visitTypes.find((v) => v.id === visitTypeId)?.name.toLowerCase() ?? 'this visit';
  return shownProviders(clinic.providers).map((p) => {
    const does = p.visitTypeIds.includes(visitTypeId);
    return { id: p.id, label: does ? providerName(p) : `${providerName(p)} (doesn't do ${visit})`, disabled: !does };
  });
}

/**
 * The open times the dialog shows: none starting sooner than the lead time from now, the same lead the assistant
 * books with (one number, BOOKING_LEAD_MINUTES, unless the server says another). A list loaded a while ago never
 * offers a time that has since passed (the desk was offered 10:00 AM at 10:20).
 */
export function upcomingSlots<T extends { startsAt: string }>(slots: T[], now: Date, leadMinutes = BOOKING_LEAD_MINUTES): T[] {
  const earliest = now.getTime() + leadMinutes * 60_000;
  return slots.filter((s) => new Date(s.startsAt).getTime() >= earliest);
}

/** The line under the times: the clinic's grid and the lead time, as the server found them. */
export function gridLabel(startEvery: number, leadMinutes = BOOKING_LEAD_MINUTES): string {
  const lead = leadMinutes % 60 === 0 ? `${leadMinutes / 60} ${leadMinutes === 60 ? 'hour' : 'hours'}` : `${leadMinutes} minutes`;
  return `Start times every ${startEvery} minutes, from ${lead} from now. For a walk-in sooner than that, use Override.`;
}
