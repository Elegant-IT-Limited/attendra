// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TextList } from '@attendra/api/contracts';
import { localDateOf } from '@attendra/core';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { StatusPill } from '@/components/ui/badge';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { clinicTime, requestNumber } from '@/lib/format';
import { textKind, textStatusWords, textTone } from '@/lib/text-kinds';
import { useTerms } from '@/lib/terms';

export type TextHistoryQuery = { patientId: string } | { recent: true; status: 'all' | 'not_sent' };

/**
 * The texts the clinic sent (text history, 2026-11-16), read-only: a household's newest 20 on a pet's or patient's page,
 * or the clinic's newest 50 in Settings > Texting. Each says when, what kind, where it is ("Waiting", "Sent",
 * "Delivered", "Not sent: <why>"), the words that went out (while the clinic keeps call records) and what it belongs
 * to: the call, the request, the visit, and in the clinic's list the pet. Every read is audited by the API.
 */
export function TextHistory({ clinicId, query, timeZone, empty }: { clinicId: string; query: TextHistoryQuery; timeZone: string; empty: string }) {
  const terms = useTerms(clinicId);
  const params = 'patientId' in query ? `patientId=${query.patientId}` : `recent=true&status=${query.status}`;
  const texts = useQuery({ queryKey: ['texts', clinicId, 'history', params], queryFn: () => api<TextList>(`/clinics/${clinicId}/texts?${params}`) });
  const clinicList = !('patientId' in query);
  if (texts.isPending) return <div className="space-y-2 p-5"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>;
  if (texts.isError) return <p className="p-5 text-sm text-text-muted">The texts did not load. Open this page again to try again.</p>;
  const rows = texts.data.texts;
  if (!rows.length) return <Empty title={empty} />;
  return (
    <ul className="divide-y divide-border" aria-label="Texts" data-testid="text-history">
      {rows.map((t) => {
        const status = textStatusWords(t);
        const day = t.appointmentStartsAt ? localDateOf(new Date(t.appointmentStartsAt), timeZone) : null;
        return (
          <li key={t.id} className="flex items-start gap-3 px-5 py-3 text-sm" data-testid="text-row" data-text-id={t.id}>
            <MessageSquare className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium" data-testid="text-kind">{textKind(t.template, terms.provider)}</span>
                <span data-testid="text-status"><StatusPill tone={textTone(t)}>{status}</StatusPill></span>
              </p>
              <p className="text-xs text-text-muted">
                <span data-testid="text-when">{clinicTime(t.sentAt ?? t.createdAt, timeZone)}</span>
                {t.toLast4 && <> · to the number ending {t.toLast4}</>}
                {clinicList && t.patientId && t.patientName && <> · <Link href={`/c/${clinicId}/patients/${t.patientId}`} className="text-primary hover:underline" data-testid="text-pet">{t.patientName}</Link></>}
              </p>
              {/* what it belongs to */}
              {(t.callId || t.taskId || t.appointmentId) && (
                <p className="flex flex-wrap gap-x-3 text-xs">
                  {t.callId && <Link href={`/c/${clinicId}/calls/${t.callId}`} className="text-primary hover:underline">The call</Link>}
                  {t.taskId && t.taskNumber !== null && t.taskNumber !== undefined && <Link href={`/c/${clinicId}/requests?${t.taskStatus === 'done' ? 'status=done&' : ''}open=${t.taskId}`} className="text-primary hover:underline">{requestNumber(t.taskNumber)}</Link>}
                  {t.appointmentId && day && <Link href={`/c/${clinicId}/schedule?date=${day}&appointment=${t.appointmentId}`} className="text-primary hover:underline">The visit</Link>}
                </p>
              )}
              {t.body
                ? (
                  <details className="group">
                    <summary className="cursor-pointer text-xs font-medium text-primary hover:underline">The words that went out</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-surface-sunken px-3 py-2 text-sm" data-testid="text-body">{t.body}</p>
                  </details>
                )
                : (t.status === 'sent' || t.status === 'delivered') && <p className="text-xs text-text-muted">The words are kept as long as call records, and this text is older.</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
