// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from '@attendra/core';
import type { ApiError, Me } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly body: ApiError) {
    super(body.message ?? body.error);
  }
}

/** Calls the dashboard API on this origin (Next forwards /api to the API service). */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({ error: 'bad_response' }));
  if (!res.ok) throw new ApiFailure(res.status, body as ApiError);
  return body as T;
}

/** Where a failed request should send the browser, if anywhere. */
export function redirectFor(error: unknown): string | null {
  if (!(error instanceof ApiFailure)) return null;
  if (error.status === 401) return '/sign-in';
  if (error.status === 403 && error.body.error === 'password_change_required') return '/change-password';
  if (error.status === 403 && error.body.error === 'two_factor_required') return '/setup-two-factor';
  return null;
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), staleTime: 60_000 });

export function useClinic(clinicId: string) {
  const me = useMe();
  const clinic = me.data?.clinics.find((c) => c.id === clinicId);
  return { ...me, clinic, can: (p: string) => !!clinic?.permissions.includes(p) };
}

/** The clinic's configuration: providers, visit types, hours and holidays. No patient data. */
export function useClinicConfig(clinicId: string) {
  return useQuery({ queryKey: ['settings', clinicId], queryFn: () => api<ClinicConfig>(`/clinics/${clinicId}/settings`), staleTime: 5 * 60_000 });
}

/** A fresh key for one write attempt. A retry of the same attempt reuses it, so it is applied once. */
export const newKey = () => crypto.randomUUID();
