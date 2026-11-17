// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TextList } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { api, useClinic } from '@/lib/api';
import { useTerms } from '@/lib/terms';
import { TextRows } from './text-rows';

/**
 * A household's texts on a pet's or patient's page (text history, 2026-11-16): the newest 20 to the number on the
 * record, read-only, one compact row each, grouped by day, each saying which pet it was about, or the household
 * (texts polish TX4), and opening to its words. Every read is audited by the API.
 */
export function TextHistory({ clinicId, patientId, timeZone, empty }: { clinicId: string; patientId: string; timeZone: string; empty: string }) {
  const terms = useTerms(clinicId);
  const { can } = useClinic(clinicId);
  const texts = useQuery({ queryKey: ['texts', clinicId, 'history', patientId], queryFn: () => api<TextList>(`/clinics/${clinicId}/texts?patientId=${patientId}`) });
  if (texts.isPending) return <div className="space-y-2 p-5"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>;
  if (texts.isError) return <p className="p-5 text-sm text-text-muted">The texts did not load. Open this page again to try again.</p>;
  if (!texts.data.texts.length) return <Empty title={empty} />;
  return <TextRows clinicId={clinicId} texts={texts.data.texts} timeZone={timeZone} wordsKeptSince={texts.data.wordsKeptSince} about canHandle={can('tasks:work')} provider={terms.provider} />;
}
