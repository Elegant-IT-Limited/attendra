// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { CallList, CallSummary } from '@attendra/api/contracts';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, Search } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { LiveNow } from '@/components/calls/live-now';
import { Outcome } from '@/components/calls/outcome';
import { PageHeader } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { StatCard } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { api, useClinic } from '@/lib/api';
import { clinicTime, duration, OUTCOMES, REFUSALS, TOOLS, zoneLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

const FILTERS = {
  all: { label: 'All calls', test: () => true },
  attention: { label: 'Needs attention', test: (c: CallSummary) => c.emergency || c.outcome === 'task_created' },
  changes: { label: 'Bookings and changes', test: (c: CallSummary) => ['booked', 'rescheduled', 'cancelled'].includes(c.outcome ?? '') },
  // asked of the server, so a flagged call further back than the first page is found too
  review: { label: 'Needs review', test: (c: CallSummary) => c.needsReview },
} as const;

// the filters come from the address, and reading it needs a Suspense boundary
export default function CallsPage() {
  return <Suspense fallback={<Skeleton className="h-96" />}><Calls /></Suspense>;
}

function Calls() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const router = useRouter();
  const { clinic, can } = useClinic(clinicId);
  // the quality page links here with its filters in the address: dates, outcome, a refusal code, the review flag
  const params = useSearchParams();
  const [filter, setFilter] = useState<keyof typeof FILTERS>(params.get('review') === 'needed' ? 'review' : 'all');
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [outcome, setOutcome] = useState(params.get('outcome') ?? '');
  const [refusal, setRefusal] = useState(params.get('refusal') ?? '');
  const [channel, setChannel] = useState('');
  const [emergencyOnly, setEmergencyOnly] = useState(false);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const filters = {
    ...(from ? { from } : {}), ...(to ? { to } : {}), ...(outcome ? { outcome } : {}), ...(channel ? { channel } : {}), ...(emergencyOnly ? { emergency: 'true' } : {}),
    ...(filter === 'review' ? { review: 'needed' } : {}), ...(refusal ? { refusal } : {}),
  };
  const searching = query.length >= 2 && can('calls:read');
  const calls = useInfiniteQuery({
    queryKey: ['calls', clinicId, filters],
    queryFn: ({ pageParam }) => api<CallList>(`/clinics/${clinicId}/calls?${new URLSearchParams({ limit: '50', ...filters, ...(pageParam ? { before: pageParam } : {}) })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    enabled: !searching,
  });
  // a name is PHI, so it goes in a POST body, never in the address or a query string
  const found = useQuery({
    queryKey: ['calls', clinicId, 'search', query, filters],
    queryFn: () => api<CallList>(`/clinics/${clinicId}/calls/search`, { method: 'POST', body: JSON.stringify({ query, ...filters, ...(emergencyOnly ? { emergency: true } : {}) }) }),
    enabled: searching,
    placeholderData: keepPreviousData,
  });
  const all = searching ? found.data?.calls ?? [] : calls.data?.pages.flatMap((p) => p.calls) ?? [];
  const pending = searching ? found.isPending : calls.isPending;
  const filtered = !!(from || to || outcome || channel || emergencyOnly || searching || refusal);
  const shown = all.filter(FILTERS[filter].test);
  const tz = clinic?.timezone ?? 'UTC';
  const openable = can('calls:read');

  const stats = [
    { label: 'Calls shown', value: all.length },
    { label: 'Booked or changed', value: all.filter(FILTERS.changes.test).length },
    { label: 'Left a request', value: all.filter((c) => c.outcome === 'task_created').length },
    { label: 'Emergencies', value: all.filter((c) => c.emergency).length, danger: true },
  ];

  return (
    <>
      <PageHeader title="Calls" description={<>Every call the assistant answered. Open one to read the transcript and see what it did. Times are {zoneLabel(tz)}.</>} />
      <LiveNow clinicId={clinicId} canWatch={openable} />
      <Card className="mb-4 px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          {can('calls:read') && (
            <div className="min-w-56 flex-1 space-y-1">
              <Label htmlFor="call-search" className="block text-xs text-text-muted">Patient</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
                <Input id="call-search" type="search" autoComplete="off" className="h-8 pl-8" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name of a verified caller" />
              </div>
            </div>
          )}
          <div className="space-y-1"><Label htmlFor="call-from" className="block text-xs text-text-muted">From</Label><Input id="call-from" type="date" className="h-8 w-38" aria-describedby="call-dates-hint" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="call-to" className="block text-xs text-text-muted">To</Label><Input id="call-to" type="date" className="h-8 w-38" aria-describedby="call-dates-hint" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <p id="call-dates-hint" className="self-end pb-1.5 text-xs text-text-muted">Times and dates are the clinic&rsquo;s.</p>
          <div className="space-y-1">
            <Label htmlFor="call-outcome" className="block text-xs text-text-muted">Outcome</Label>
            <Select id="call-outcome" className="h-8 w-40" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">Any outcome</option>
              {Object.entries(OUTCOMES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="call-channel" className="block text-xs text-text-muted">Channel</Label>
            <Select id="call-channel" className="h-8 w-36" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">Any channel</option>
              <option value="phone">Phone</option>
              <option value="web">Browser test</option>
            </Select>
          </div>
          <label className="flex h-8 items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={emergencyOnly} onChange={(e) => setEmergencyOnly(e.target.checked)} /> Emergencies only</label>
          {refusal && <Badge tone="warn" className="h-8 px-2 text-sm">Refused: {REFUSALS[refusal] ?? refusal}</Badge>}
          {filtered && <Button size="sm" variant="ghost" onClick={() => { setFrom(''); setTo(''); setOutcome(''); setChannel(''); setEmergencyOnly(false); setText(''); setRefusal(''); }}>Clear</Button>}
        </div>
      </Card>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => <StatCard key={s.label} label={s.label} value={pending ? null : s.value} tone={s.danger ? 'danger' : undefined} />)}
      </div>
      <div className="mb-3 flex flex-wrap gap-2" role="tablist">
        {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? 'primary' : 'outline'} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>{FILTERS[f].label}</Button>
        ))}
      </div>
      <Card>
        {(searching ? found.isError : calls.isError) && <Alert tone="danger" className="m-4">The call list did not load. It retries on its own; refresh if it keeps failing.</Alert>}
        {pending ? (
          <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}</div>
        ) : shown.length === 0 ? (
          <Empty title="No calls here">{searching ? 'No verified caller by that name. Calls where nobody was verified cannot be found by name.' : filter === 'all' && !filtered ? 'Calls appear as soon as the assistant answers one.' : 'Nothing matches these filters.'}</Empty>
        ) : (
          <Table>
            <THead><tr><TH>When</TH><TH>Outcome</TH><TH>Caller</TH><TH className="hidden md:table-cell">What the assistant did</TH><TH className="text-right">Length</TH></tr></THead>
            <tbody>
              {shown.map((c) => (
                <TRow key={c.id} className={cn(openable && 'cursor-pointer hover:bg-surface-sunken/60')} onClick={() => openable && router.push(`/c/${clinicId}/calls/${c.id}`)}>
                  <TD className="whitespace-nowrap">
                    {openable ? <Link href={`/c/${clinicId}/calls/${c.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{clinicTime(c.startedAt, tz)}</Link> : clinicTime(c.startedAt, tz)}
                  </TD>
                  <TD>
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <Outcome outcome={c.outcome} emergency={c.emergency} />
                      {c.channel === 'web' && <Badge tone="accent">Browser test</Badge>}
                      {c.needsReview && <Badge tone="warn">Needs review</Badge>}
                    </span>
                  </TD>
                  <TD className="whitespace-nowrap text-text-muted">
                    {c.patientName
                      ? <span className="inline-flex items-center gap-1 text-text"><CheckCircle2 className="size-4 text-primary" aria-label="Verified" /> {c.patientName}</span>
                      : c.verified
                        ? <span className="inline-flex items-center gap-1 text-text"><CheckCircle2 className="size-4 text-primary" /> Verified caller</span>
                        : <span className="inline-flex items-center gap-1"><CircleDashed className="size-4" /> Unknown caller</span>}
                  </TD>
                  <TD className="hidden text-text-muted md:table-cell">{c.tools.map((t) => TOOLS[t] ?? t).join(', ') || 'Talked only'}</TD>
                  <TD className="text-right tabular-nums text-text-muted">{duration(c.voiceSeconds)}</TD>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {searching && found.data?.truncated && <p className="mt-3 text-xs text-text-muted">Showing the first matches; type more of the name.</p>}
      {!searching && calls.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => calls.fetchNextPage()} disabled={calls.isFetchingNextPage}>{calls.isFetchingNextPage ? 'Loading…' : 'Older calls'}</Button>
        </div>
      )}
    </>
  );
}
