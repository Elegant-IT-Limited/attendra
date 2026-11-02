// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, usePathname } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import type { CallList, Overview } from '@attendra/api/contracts';
import { api } from '@/lib/api';
import { TestCallProvider } from '@/components/calls/test-call';
import { Shell } from '@/components/shell';

export default function ClinicLayout({ children }: { children: ReactNode }) {
  const { clinicId } = useParams<{ clinicId: string }>();
  const queries = useQueryClient();
  const path = usePathname();
  // Today's first two answers are asked for at once, alongside who you are, not one round trip after it (every role
  // reads them): from far away each round trip is a third of a second
  useEffect(() => {
    if (path !== `/c/${clinicId}`) return;
    void queries.prefetchQuery({ queryKey: ['overview', clinicId], queryFn: () => api<Overview>(`/clinics/${clinicId}/overview?days=7`) });
    void queries.prefetchQuery({ queryKey: ['calls', clinicId, 'recent'], queryFn: () => api<CallList>(`/clinics/${clinicId}/calls?limit=50`) });
  }, [clinicId]); // once per clinic, on the way in
  // the test call outlives the page it started on: it belongs to the clinic, around the frame
  return <TestCallProvider clinicId={clinicId}><Shell clinicId={clinicId}>{children}</Shell></TestCallProvider>;
}
