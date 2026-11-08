// SPDX-License-Identifier: AGPL-3.0-only
import type { DoctorList, MemberList, PatientList, Quality, TeamInvitationList, TestCallAllowance } from '@attendra/api/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * The first answers each page shows, as one key and one request: the page reads them with these, and the sidebar
 * asks for them ahead, when a link is hovered, focused or touched (note 17), so the page opens on data already
 * here. One place, so the two can never ask for different keys and fetch twice.
 */
export const pageData = {
  doctors: (clinicId: string) => ({ queryKey: ['doctors', clinicId], queryFn: () => api<DoctorList>(`/clinics/${clinicId}/doctors`) }),
  members: (clinicId: string) => ({ queryKey: ['members', clinicId], queryFn: () => api<MemberList>(`/clinics/${clinicId}/members`) }),
  invitations: (clinicId: string) => ({ queryKey: ['members', clinicId, 'invitations'], queryFn: () => api<TeamInvitationList>(`/clinics/${clinicId}/invitations`) }),
  newestPatients: (clinicId: string) => ({ queryKey: ['patients', clinicId, 'all'], queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients`) }),
  recentPatients: (clinicId: string) => ({ queryKey: ['patient', clinicId, 'recent'], queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients/recent`) }),
  quality: (clinicId: string) => ({ queryKey: ['quality', clinicId], queryFn: () => api<Quality>(`/clinics/${clinicId}/quality?weeks=26`) }),
  testCallAllowance: (clinicId: string) => ({ queryKey: ['test-call-allowance', clinicId], queryFn: () => api<TestCallAllowance>(`/clinics/${clinicId}/test-calls/allowance`) }),
} as const;

/**
 * What each sidebar page asks for first, by its href (lib/nav.ts). Today is asked for on the way in (the clinic
 * layout); Schedule, Requests, Calls and Settings depend on the page's own state (a day, filters, a versioned copy),
 * so Next fetches their code ahead and the data comes with the page.
 */
export const PAGE_PREFETCH: Record<string, ((clinicId: string) => { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> })[]> = {
  patients: [pageData.newestPatients, pageData.recentPatients],
  doctors: [pageData.doctors],
  team: [pageData.members, pageData.invitations],
  quality: [pageData.quality],
  'test-call': [pageData.testCallAllowance],
};

/** Asks for a page's first answers ahead; anything still fresh (15 s, app/providers.tsx) is not asked for again. */
export function prefetchPage(queries: QueryClient, clinicId: string, href: string) {
  for (const data of PAGE_PREFETCH[href] ?? []) void queries.prefetchQuery(data(clinicId));
}
