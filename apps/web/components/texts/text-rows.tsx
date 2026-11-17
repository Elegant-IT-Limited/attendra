// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TextItem } from '@attendra/api/contracts';
import { addDays, localDateOf } from '@attendra/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { StatusPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useProblem, useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { clinicTime, dayTitle, requestNumber, timeOf } from '@/lib/format';
import { textKind, textStatusWords, textTone } from '@/lib/text-kinds';
import { cn } from '@/lib/utils';

/** The pill: Delivered, Sent, Waiting or Not sent. Why a text was not sent is in the row's details (texts polish TX3). */
export const textPill = (t: Pick<TextItem, 'status' | 'failureReason' | 'errorCode'>) => {
  const words = textStatusWords(t);
  return words.startsWith('Not sent') ? 'Not sent' : words;
};
const failed = (t: Pick<TextItem, 'status'>) => t.status === 'not_sent' || t.status === 'failed' || t.status === 'undelivered';

/** "16 Nov": a day as the texts' notes say it. */
const shortDay = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(new Date(iso));

/**
 * Where a sent text's words are when it has none (texts polish TX5): sent before this server kept words (migration
 * 0059), or older than the clinic keeps call records.
 */
export function noWords(t: Pick<TextItem, 'status' | 'body' | 'createdAt'>, wordsKeptSince: string | null | undefined, timeZone: string): string | null {
  if (t.body || (t.status !== 'sent' && t.status !== 'delivered')) return null;
  if (wordsKeptSince && t.createdAt < wordsKeptSince) return `Words not kept (sent before ${shortDay(wordsKeptSince, timeZone)})`;
  return 'Words not kept: this text is older than your call records are kept.';
}

/** "Today", "Yesterday", "Mon 16 Nov": a day's heading, on the clinic's calendar. */
export function dayHeading(day: string, today: string) {
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  return dayTitle(day, 'short');
}

/**
 * The clinic's texts, one compact row each, grouped by day (texts polish TX3): time · pet (owner) · kind · status. The
 * row opens to its details: the request, the visit and the call it belongs to, the number's last four digits, the
 * words that went out, why one was not sent, and Handled for a text not sent. In a household's list (`about`), the
 * row says which pet each text was about, or the household (TX4).
 */
export function TextRows({ clinicId, texts, timeZone, wordsKeptSince, about = false, canHandle, provider, now = new Date() }: {
  clinicId: string; texts: TextItem[]; timeZone: string; wordsKeptSince?: string | null; about?: boolean; canHandle: boolean; provider: string; now?: Date;
}) {
  const today = localDateOf(now, timeZone);
  const days: { day: string; texts: TextItem[] }[] = [];
  for (const t of texts) {
    const day = localDateOf(new Date(t.sentAt ?? t.createdAt), timeZone);
    if (days.at(-1)?.day === day) days.at(-1)!.texts.push(t);
    else days.push({ day, texts: [t] });
  }
  return (
    <div data-testid="text-history">
      {days.map((d) => (
        <section key={d.day} aria-label={dayHeading(d.day, today)} data-testid="text-day">
          <h3 className="sticky top-0 z-[1] border-b border-border bg-surface-sunken/95 px-5 py-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">{dayHeading(d.day, today)}</h3>
          <ul className="divide-y divide-border" aria-label={`Texts, ${dayHeading(d.day, today)}`}>
            {d.texts.map((t) => <TextRow key={t.id} clinicId={clinicId} t={t} timeZone={timeZone} wordsKeptSince={wordsKeptSince} about={about} canHandle={canHandle} provider={provider} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TextRow({ clinicId, t, timeZone, wordsKeptSince, about, canHandle, provider }: { clinicId: string; t: TextItem; timeZone: string; wordsKeptSince?: string | null; about: boolean; canHandle: boolean; provider: string }) {
  const [open, setOpen] = useState(false);
  const who = about
    ? (t.patientFirstName ? `about ${t.patientFirstName}` : 'about the household')
    : (t.patientName ? `${t.patientName}${t.ownerName ? ` (${t.ownerName})` : ''}` : 'Not on file');
  const day = t.appointmentStartsAt ? localDateOf(new Date(t.appointmentStartsAt), timeZone) : null;
  const status = textStatusWords(t);
  const words = noWords(t, wordsKeptSince, timeZone);
  const detailsId = `text-${t.id}-details`;
  return (
    <li data-testid="text-row" data-text-id={t.id} className={cn(open && 'bg-surface-sunken/40')}>
      <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}
        className="focus-ring grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 px-5 py-2.5 text-left text-sm hover:bg-surface-sunken/60 sm:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,14rem)_auto_auto]">
        {/* phone: two lines, kind and status, then time and who; wider: one line */}
        <span className="col-start-1 row-start-2 flex min-w-0 gap-1 text-xs text-text-muted sm:contents sm:text-sm">
          <span className="shrink-0 tabular-nums sm:col-start-1 sm:row-start-1" data-testid="text-when">{timeOf(t.sentAt ?? t.createdAt, timeZone)}</span>
          <span aria-hidden className="sm:hidden">·</span>
          <span className="truncate sm:col-start-2 sm:row-start-1 sm:text-text" data-testid={about ? 'text-about' : 'text-who'}>{who}</span>
        </span>
        <span className="col-start-1 row-start-1 truncate font-medium sm:col-start-3 sm:font-normal" data-testid="text-kind">{textKind(t.template, provider)}</span>
        <span className="col-start-2 row-start-1 sm:col-start-4" data-testid="text-status"><StatusPill tone={textTone(t)}>{textPill(t)}</StatusPill></span>
        <ChevronRight className={cn('col-start-2 row-start-2 size-4 justify-self-end text-text-muted transition-transform sm:col-start-5 sm:row-start-1', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <div id={detailsId} className="space-y-2 px-5 pb-3 text-sm sm:pl-[6.25rem]" data-testid="text-details">
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
            <span>{clinicTime(t.sentAt ?? t.createdAt, timeZone)}</span>
            {t.toLast4 && <span data-testid="text-last4">To the number ending {t.toLast4}</span>}
            {!about && t.patientId && t.patientName && <Link href={`/c/${clinicId}/patients/${t.patientId}`} className="text-primary hover:underline" data-testid="text-pet">{t.patientName}</Link>}
            {t.taskId && t.taskNumber !== null && t.taskNumber !== undefined && <Link href={`/c/${clinicId}/requests?${t.taskStatus === 'done' ? 'status=done&' : ''}open=${t.taskId}`} className="text-primary hover:underline" data-testid="text-request">{requestNumber(t.taskNumber)}</Link>}
            {t.appointmentId && day && <Link href={`/c/${clinicId}/schedule?date=${day}&appointment=${t.appointmentId}`} className="text-primary hover:underline">The visit</Link>}
            {t.callId && <Link href={`/c/${clinicId}/calls/${t.callId}`} className="text-primary hover:underline">The call</Link>}
          </p>
          {failed(t) && <p className="text-sm" data-testid="text-why">{status}.</p>}
          {t.body
            ? (
              <div>
                <p className="text-xs font-medium text-text-muted">The words that went out</p>
                <p className="mt-1 max-w-xl whitespace-pre-wrap break-words rounded-md bg-surface px-3 py-2 text-sm" data-testid="text-body">{t.body}</p>
              </div>
            )
            : words && <p className="text-xs text-text-muted" data-testid="text-no-words">{words}</p>}
          {failed(t) && <Handled clinicId={clinicId} t={t} timeZone={timeZone} canHandle={canHandle} />}
        </div>
      )}
    </li>
  );
}

/** A text not sent: who marked it handled and when, or the button to (texts polish TX2). Never silent: done or why not. */
function Handled({ clinicId, t, timeZone, canHandle }: { clinicId: string; t: TextItem; timeZone: string; canHandle: boolean }) {
  const queries = useQueryClient();
  const toast = useToast();
  const problem = useProblem();
  const mark = useMutation({
    mutationFn: (handled: boolean) => api<{ handled: boolean }>(`/clinics/${clinicId}/texts/${t.id}/handled`, { method: 'POST', body: JSON.stringify({ handled }) }),
    onSuccess: (r) => {
      toast({ tone: 'success', message: r.handled ? 'Marked handled. It is off Today.' : 'Marked not handled. It is back on Today.' });
      void queries.invalidateQueries({ queryKey: ['texts', clinicId] });
    },
    onError: () => problem({ title: 'Not changed', message: 'That did not save. Try again.' }),
  });
  if (t.handledAt) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-text-muted" data-testid="text-handled">
        Handled by {t.handledBy ?? 'a former staff member'}, {clinicTime(t.handledAt, timeZone)}.
        {canHandle && <Button size="sm" variant="ghost" disabled={mark.isPending} onClick={() => mark.mutate(false)}>Not handled</Button>}
      </p>
    );
  }
  if (!canHandle) return <p className="text-xs text-text-muted">Nobody has marked it handled yet.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={mark.isPending} onClick={() => mark.mutate(true)} data-testid="text-mark-handled">Mark handled</Button>
      <span className="text-xs text-text-muted">Once someone has called them, or it needs nothing. It leaves Today.</span>
    </div>
  );
}
