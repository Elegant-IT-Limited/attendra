// SPDX-License-Identifier: AGPL-3.0-only
import { capitalized, industryPack, type Terms } from '@attendra/core';
import { useClinicConfig } from '@/lib/api';

/** What things are called at this account, from its industry pack. Until the settings load, the clinic's words. */
export function useTerms(clinicId: string): Terms & { title: (t: keyof Terms) => string } {
  const config = useClinicConfig(clinicId);
  const terms = industryPack(config.data?.industry).terms;
  return { ...terms, title: (t) => capitalized(terms[t]) };
}

/** Whether this account's records are pets (the veterinary pack): owners call, pets are booked. */
export function usePets(clinicId: string): boolean {
  const config = useClinicConfig(clinicId);
  return industryPack(config.data?.industry).identity === 'pet';
}
