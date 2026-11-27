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
import { markProblemsSeen, problemHref, problemLine, seenProblems, textsNotSentHref, unseen } from '@/lib/text-problems';
import { textsNotSent } from '@attendra/core';

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
      // "1 text was not sent", "2 texts were not sent" (core textsNotSent, texts polish TX6)
      title: textsNotSent(fresh.length),
      message: one
        ? <>{problemLine(one, terms.patient)}. <Link href={problemHref(clinicId, one)} className="text-primary underline">Open R-{one.number}</Link> to call the {terms.patient === 'pet' ? 'owner' : 'patient'} instead.</>
        : <>Each request&apos;s history says so too. Call them instead, then mark each handled on <Link href={textsNotSentHref(clinicId, list.data!.from)} className="text-primary underline">Texts</Link>.</>,
      ...(one ? {} : { items: fresh.map((p) => problemLine(p, terms.patient)) }),
    });
  }, [list.data, clinicId, problem, terms.patient]);
  return null;
}
