// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TextProblems } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect } from 'react';
import { useProblem } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { SAFETY_POLL_MS } from '@/lib/changes';
import { useTerms } from '@/lib/terms';
import { markProblemsSeen, problemHref, problemLine, seenProblems, unseen } from '@/lib/text-problems';

/**
 * A text about a request that was not sent, said wherever the person is on the dashboard, in a notice that stays until
 * read (note 2026-11-16, demo findings 3): the failure often comes after the request was closed and its panel is gone.
 * Kept current by the 'texts' change stream; each text is shown once in this browser.
 */
export function TextProblemNotice({ clinicId, enabled }: { clinicId: string; enabled: boolean }) {
  const problem = useProblem();
  const terms = useTerms(clinicId);
  const list = useQuery({
    queryKey: ['texts', clinicId, 'problems'],
    queryFn: () => api<TextProblems>(`/clinics/${clinicId}/tasks/text-problems`),
    enabled, refetchInterval: SAFETY_POLL_MS,
  });
  useEffect(() => {
    const fresh = unseen(list.data?.problems ?? [], seenProblems(clinicId));
    if (!fresh.length) return;
    markProblemsSeen(clinicId, fresh.map((p) => p.textId));
    const one = fresh.length === 1 ? fresh[0]! : null;
    problem({
      title: one ? 'A text was not sent' : `${fresh.length} texts were not sent`,
      message: one
        ? <>{problemLine(one, terms.patient)}. <Link href={problemHref(clinicId, one)} className="text-primary underline">Open R-{one.number}</Link> to call the {terms.patient === 'pet' ? 'owner' : 'patient'} instead.</>
        : <>Each request&apos;s history says so too. Call them instead, from <Link href={`/c/${clinicId}/requests?status=done`} className="text-primary underline">Requests</Link>.</>,
      ...(one ? {} : { items: fresh.map((p) => problemLine(p, terms.patient)) }),
    });
  }, [list.data, clinicId, problem, terms.patient]);
  return null;
}
