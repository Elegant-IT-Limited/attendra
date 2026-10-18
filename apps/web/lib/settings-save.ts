// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { ClinicConfig } from '@attendra/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiFailure, apiTagged } from './api';

/**
 * A Settings page that changes only some of the settings (Texting): it reads them with
 * their version, and saves its own keys over the newest copy. When someone else saved
 * meanwhile, their save is kept and these keys go on top of it, once.
 */
export function useSettingsSlice(clinicId: string) {
  const queries = useQueryClient();
  const loaded = useQuery({ queryKey: ['settings-versioned', clinicId], queryFn: () => apiTagged<ClinicConfig>(`/clinics/${clinicId}/settings`), gcTime: 0, refetchOnWindowFocus: false });
  const keep = (body: ClinicConfig, etag: string | null) => {
    queries.setQueryData(['settings-versioned', clinicId], { body, etag });
    queries.setQueryData(['settings', clinicId], body);
  };
  const put = (body: ClinicConfig, etag: string | null) =>
    apiTagged<ClinicConfig>(`/clinics/${clinicId}/settings`, { method: 'PUT', body: JSON.stringify(body), headers: etag ? { 'if-match': etag } : {} });

  async function save(patch: Partial<ClinicConfig>): Promise<ClinicConfig> {
    const base = loaded.data;
    if (!base) throw new Error('settings not loaded');
    try {
      const saved = await put({ ...base.body, ...patch }, base.etag);
      keep(saved.body, saved.etag);
      return saved.body;
    } catch (err) {
      const conflict = err instanceof ApiFailure && err.status === 409 ? (err.body as unknown as { error?: string; current?: ClinicConfig; version?: number }) : null;
      if (conflict?.error !== 'settings_changed' || !conflict.current) throw err;
      const saved = await put({ ...conflict.current, ...patch }, `"v${conflict.version}"`);
      keep(saved.body, saved.etag);
      return saved.body;
    }
  }
  return { config: loaded.data?.body, isError: loaded.isError, save };
}
