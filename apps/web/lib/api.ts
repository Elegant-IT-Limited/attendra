// SPDX-License-Identifier: AGPL-3.0-only
import type { ClinicConfig } from '@attendra/core';
import type { ApiError, Me } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly body: ApiError) {
    super(body.message ?? body.error);
  }
}

/** What the dashboard says when the API is still busy after its retries. */
export const BUSY = 'Attendra is busy for a moment. Try again in a few seconds.';
/** The browser event the problem dialog listens for, sent once a request has run out of retries on a 429. */
export const BUSY_EVENT = 'attendra:busy';

/** True for a request the API turned away as too many: say BUSY rather than an empty list. */
export const isBusy = (error: unknown) => error instanceof ApiFailure && error.status === 429;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// waits between tries after a 429 with no Retry-After: 2 s, then 5 s; never more than twice
const BUSY_WAITS = [2_000, 5_000];

/**
 * One request on this origin (Next forwards /api to the API service). A 429 is never
 * silent: it is tried again after the API's Retry-After (or 2 s, then 5 s), at most
 * twice, and then the problem dialog says so.
 */
async function send(path: string, init: RequestInit): Promise<Response> {
  for (let tried = 0; ; tried++) {
    const res = await fetch(`/api/v1${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
    if (res.status !== 429) return res;
    if (tried === BUSY_WAITS.length) {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(BUSY_EVENT));
      return res;
    }
    const after = Number(res.headers.get('retry-after'));
    await wait(after > 0 && after <= 60 ? after * 1000 : BUSY_WAITS[tried]!);
  }
}

/** Calls the dashboard API on this origin (Next forwards /api to the API service). */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init);
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({ error: 'bad_response' }));
  if (!res.ok) throw new ApiFailure(res.status, body as ApiError);
  return body as T;
}

/** The same call, with the response's ETag: the version to send back as If-Match when saving. */
export async function apiTagged<T>(path: string, init: RequestInit = {}): Promise<{ body: T; etag: string | null }> {
  const res = await send(path, init);
  const body = await res.json().catch(() => ({ error: 'bad_response' }));
  if (!res.ok) throw new ApiFailure(res.status, body as ApiError);
  return { body: body as T, etag: res.headers.get('etag') };
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
