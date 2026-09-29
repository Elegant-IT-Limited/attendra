// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { CallDetail } from '@attendra/api/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Flag, Sparkles } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

export const INTENTS: Record<string, string> = {
  book: 'Booking', reschedule: 'Reschedule', cancel: 'Cancellation', refill: 'Refill', question: 'Question', callback: 'Callback', emergency: 'Emergency', other: 'Other',
};
const SENTIMENT: Record<string, { label: string; tone: BadgeTone }> = {
  calm: { label: 'Calm', tone: 'neutral' }, frustrated: { label: 'Frustrated', tone: 'warn' }, distressed: { label: 'Distressed', tone: 'danger' },
};

/**
 * The worker's summary of the call: two or three sentences for staff, what the caller
 * wanted and how they came across, and whether someone should look at the call. It is
 * written from the transcript, so it is shown beside it, never instead of it.
 */
export function SummaryCard({ clinicId, call, canReview }: { clinicId: string; call: CallDetail; canReview: boolean }) {
  const queries = useQueryClient();
  const toast = useToast();
  const review = useMutation({
    mutationFn: () => api<void>(`/clinics/${clinicId}/calls/${call.id}/review`, { method: 'POST' }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['call', clinicId, call.id] });
      void queries.invalidateQueries({ queryKey: ['calls', clinicId] });
      toast({ tone: 'success', message: 'Marked as reviewed.' });
    },
    onError: () => toast({ tone: 'error', message: 'That did not save. Try again.' }),
  });
  const s = call.summary;

  if (!s) {
    const job = call.summaryJob;
    const text = !call.endedAt ? 'The summary is written when the call ends.'
      : job?.state === 'failed' ? 'The summary could not be written. The transcript is complete.'
        : job ? 'The summary is being written. It appears here in a moment.'
          : 'No summary for this call.';
    return (
      <Card>
        <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-text-muted">{text}</p></CardContent>
      </Card>
    );
  }

  const open = s.needsReview && !s.reviewedAt;
  return (
    <Card data-testid="call-summary">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Summary</CardTitle>
        <span className="inline-flex items-center gap-1 text-xs text-text-muted"><Sparkles className="size-3" aria-hidden />{s.model === 'local' ? 'From the call\'s facts' : 'Written by AI'}</span>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={s.intent === 'emergency' ? 'danger' : 'accent'}>{INTENTS[s.intent] ?? s.intent}</Badge>
          <Badge tone={SENTIMENT[s.sentiment]?.tone ?? 'neutral'}>{SENTIMENT[s.sentiment]?.label ?? s.sentiment}</Badge>
          {open && <Badge tone="warn"><Flag aria-hidden /> Needs review</Badge>}
        </div>
        <p className="leading-relaxed">{s.summary}</p>
        {s.followUp && <p><span className="font-medium">Suggested next step:</span> {s.followUp}</p>}
        {s.needsReview && (
          <div className="rounded-md border border-border bg-surface-sunken px-3 py-2">
            <p><span className="font-medium">Why review:</span> {s.reviewReason}</p>
            {s.reviewedAt
              ? <p className="mt-1 text-xs text-text-muted">Reviewed{s.reviewedBy ? ` by ${s.reviewedBy}` : ''}.</p>
              : canReview && <Button size="sm" variant="outline" className="mt-2" loading={review.isPending} onClick={() => review.mutate()}>Mark as reviewed</Button>}
          </div>
        )}
        <p className="border-t border-border pt-3 text-xs text-text-muted">A summary of what was said. Check the transcript before acting on it.</p>
      </CardContent>
    </Card>
  );
}
