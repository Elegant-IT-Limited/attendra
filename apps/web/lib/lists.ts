// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type ClinicConfig, type ListName, managedList, onList } from '@attendra/core';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiFailure, useClinic } from '@/lib/api';

/**
 * Adds a value to one of the clinic's lists (Settings, Fields and lists) from a form that
 * picks from it: "+ Add a specialty…", or "Add to the list" by a value a record already
 * has. The list is read fresh first, so nobody else's change since the page loaded is
 * lost, and saved whole with the same route as Settings. Owners and managers only: for
 * anyone else `add` is null and the form only picks.
 */
export function useAddToList(clinicId: string, name: ListName) {
  const queries = useQueryClient();
  const { can } = useClinic(clinicId);
  if (!can('settings:write')) return null;
  /** Resolves to the value as the list spells it; rejects with a sentence to show under the field. */
  return async (raw: string): Promise<string> => {
    const typed = raw.trim().replace(/\s+/g, ' ');
    // kinds of animal are listed with a capital, like the starting list: "Hamster"
    const value = name === 'species' ? typed.charAt(0).toUpperCase() + typed.slice(1) : typed;
    if (!value) throw new Error('Type the new value first.');
    if (value.length > 40) throw new Error('Keep it to 40 characters.');
    try {
      const fresh = await api<ClinicConfig>(`/clinics/${clinicId}/settings`);
      const list = managedList(fresh, name);
      const known = list.find((v) => onList([v], value));
      if (known) { queries.setQueryData(['settings', clinicId], fresh); return known; }
      const saved = await api<ClinicConfig>(`/clinics/${clinicId}/settings/lists/${name}`, { method: 'PUT', body: JSON.stringify({ values: [...list, value], renamed: {} }) });
      queries.setQueryData(['settings', clinicId], saved);
      void queries.invalidateQueries({ queryKey: ['doctors', clinicId] });
      return value;
    } catch (e) {
      throw new Error(e instanceof ApiFailure ? (e.body.issues?.map((i) => i.message).join('. ') || e.body.message || 'That was not added.') : 'That was not added. Check your connection and try again.', { cause: e });
    }
  };
}
