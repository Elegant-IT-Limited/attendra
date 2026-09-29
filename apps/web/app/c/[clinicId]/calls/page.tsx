// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { CallList, CallSummary } from '@attendra/api/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Outcome } from '@/components/calls/outcome';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { api, useClinic } from '@/lib/api';
import { clinicTime, duration, TOOLS } from '@/lib/format';
import { cn } from '@/lib/utils';

const FILTERS = {
  all: { label: 'All calls', test: () => true },
  attention: { label: 'Needs attention', test: (c: CallSummary) => c.emergency || c.outcome === 'task_created' },
  changes: { label: 'Bookings and changes', test: (c: CallSummary) => ['booked', 'rescheduled', 'cancelled'].includes(c.outcome ?? '') },
} as const;

export default function Calls() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const router = useRouter();
  const { clinic, can } = useClinic(clinicId);
  const [filter, setFilter] = useState<keyof typeof FILTERS>('all');
  const calls = useInfiniteQuery({
    queryKey: ['calls', clinicId],
    queryFn: ({ pageParam }) => api<CallList>(`/clinics/${clinicId}/calls?limit=50${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    refetchInterval: 30_000,
  });
  const all = calls.data?.pages.flatMap((p) => p.calls) ?? [];
  const shown = all.filter(FILTERS[filter].test);
  const tz = clinic?.timezone ?? 'UTC';
  const openable = can('calls:read');

  const stats = [
    { label: 'Calls shown', value: all.length },
    { label: 'Booked or changed', value: all.filter(FILTERS.changes.test).length },
    { label: 'Handed to staff', value: all.filter((c) => c.outcome === 'task_created').length },
    { label: 'Emergencies', value: all.filter((c) => c.emergency).length, danger: true },
  ];

  return (
    <>
      <PageHeader title="Calls" description="Every call the assistant answered. Open one to read the transcript and see what it did." />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="px-4 py-3">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className={cn('text-2xl font-semibold tabular-nums', s.danger && s.value > 0 && 'text-danger')}>{calls.isPending ? '' : s.value}</p>
          </Card>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap gap-2" role="tablist">
        {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? 'primary' : 'outline'} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>{FILTERS[f].label}</Button>
        ))}
      </div>
      <Card>
        {calls.isError && <Alert tone="danger" className="m-4">The call list did not load. It retries on its own; refresh if it keeps failing.</Alert>}
        {calls.isPending ? (
          <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}</div>
        ) : shown.length === 0 ? (
          <Empty title="No calls here">{filter === 'all' ? 'Calls appear as soon as the assistant answers one.' : 'Nothing matches this filter.'}</Empty>
        ) : (
          <Table>
            <THead><tr><TH>When</TH><TH>Outcome</TH><TH>Caller</TH><TH className="hidden md:table-cell">What the assistant did</TH><TH className="text-right">Length</TH></tr></THead>
            <tbody>
              {shown.map((c) => (
                <TRow key={c.id} className={cn(openable && 'cursor-pointer hover:bg-muted/60')} onClick={() => openable && router.push(`/c/${clinicId}/calls/${c.id}`)}>
                  <TD className="whitespace-nowrap">
                    {openable ? <Link href={`/c/${clinicId}/calls/${c.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{clinicTime(c.startedAt, tz)}</Link> : clinicTime(c.startedAt, tz)}
                  </TD>
                  <TD>
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <Outcome outcome={c.outcome} emergency={c.emergency} />
                      {c.channel === 'web' && <Badge tone="accent">Browser test</Badge>}
                    </span>
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">
                    {c.verified
                      ? <span className="inline-flex items-center gap-1 text-foreground"><CheckCircle2 className="size-4 text-primary" /> Verified</span>
                      : <span className="inline-flex items-center gap-1"><CircleDashed className="size-4" /> Not verified</span>}
                  </TD>
                  <TD className="hidden text-muted-foreground md:table-cell">{c.tools.map((t) => TOOLS[t] ?? t).join(', ') || 'Talked only'}</TD>
                  <TD className="text-right tabular-nums text-muted-foreground">{duration(c.voiceSeconds)}</TD>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {calls.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => calls.fetchNextPage()} disabled={calls.isFetchingNextPage}>{calls.isFetchingNextPage ? 'Loading…' : 'Older calls'}</Button>
        </div>
      )}
    </>
  );
}
