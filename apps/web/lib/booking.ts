// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, providerName, shownProviders } from '@attendra/core';

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
 * The open times the dialog shows: none starting sooner than the desk's lead time from now, as the slots API sends it
 * (the server owns the number). A list loaded a while ago never offers a time that has since passed (the desk was
 * offered 10:00 AM at 10:20).
 */
export function upcomingSlots<T extends { startsAt: string }>(slots: T[], now: Date, leadMinutes: number): T[] {
  const earliest = now.getTime() + leadMinutes * 60_000;
  return slots.filter((s) => new Date(s.startsAt).getTime() >= earliest);
}

/** The line under the times: the clinic's grid and the desk's lead time, both as the server sent them. */
export function gridLabel(startEvery: number, leadMinutes: number): string {
  return `Start times every ${startEvery} minutes. Times starting in the next ${leadMinutes} minutes are not shown; for one sooner, use Override.`;
}
