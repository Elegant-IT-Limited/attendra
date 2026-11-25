// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TextPage, TextSummary } from '@attendra/api/contracts';
import { countOf, TEXT_GROUP_NAMES, TEXT_GROUPS, type TextGroup } from '@attendra/core';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useSettled } from '@/components/patients/patient-search';
import { PageHeader } from '@/components/shell';
import { TextRows } from '@/components/texts/text-rows';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/tabs';
import { api, useClinic, useClinicConfig } from '@/lib/api';
import { SAFETY_POLL_MS } from '@/lib/changes';
import { TEXT_KINDS } from '@/lib/text-kinds';
import { notHandledWords } from '@/lib/text-problems';
import { useTerms } from '@/lib/terms';
import { cn } from '@/lib/utils';

const STATUS = { all: 'All', sent: 'Sent', not_sent: 'Not sent', needs_handling: 'Needs handling' } as const;
type Status = keyof typeof STATUS;
/** The first page: 10, then 20 more at a time. */
const FIRST = 10;
const MORE = 20;

// the filters come from the address (Today links here with them), and reading it needs a Suspense boundary
export default function TextsPage() {
  return <Suspense fallback={<Skeleton className="h-96" />}><Texts /></Suspense>;
}

/**
 * Texts (texts polish TX3, 2026-11-17): every text the clinic sent, in its own place, short and easy to scan. A strip of
 * today's and the last 7 days' counts, each a filter; a search by pet, owner, the number's last four digits or the
 * request's number; filters by status, kind and days; one compact row per text, grouped by day, opening to its details;
 * 10 at first, then more.
 */
function Texts() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { can } = useClinic(clinicId);
  const config = useClinicConfig(clinicId);
  const terms = useTerms(clinicId);
  const params = useSearchParams();
  const [status, setStatus] = useState<Status>(Object.hasOwn(STATUS, params.get('status') ?? '') ? params.get('status') as Status : 'all');
  const [kind, setKind] = useState(params.get('kind') ?? '');
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [text, setText] = useState('');
  const q = useSettled(text.trim());
  const tz = config.data?.timezone ?? 'UTC';
  const filters = { q, status, kind, ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const summary = useQuery({ queryKey: ['texts', clinicId, 'summary'], queryFn: () => api<TextSummary>(`/clinics/${clinicId}/texts/summary`), refetchInterval: SAFETY_POLL_MS });
  // a name or a number is PHI: it goes in a POST body, never in the address
  const texts = useInfiniteQuery({
    queryKey: ['texts', clinicId, 'page', filters],
    queryFn: ({ pageParam }) => api<TextPage>(`/clinics/${clinicId}/texts/search`, { method: 'POST', body: JSON.stringify({ ...filters, ...(pageParam ? { cursor: pageParam, limit: MORE } : { limit: FIRST }) }) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    placeholderData: keepPreviousData,
    refetchInterval: SAFETY_POLL_MS,
  });
  const rows = texts.data?.pages.flatMap((p) => p.texts) ?? [];
  const filtered = !!(q || status !== 'all' || kind || from || to);
  const clear = () => { setText(''); setStatus('all'); setKind(''); setFrom(''); setTo(''); };
  const pick = (s: Status, f: string) => { setStatus(s); setFrom(f); setTo(''); };
  const retention = config.data?.retentionDays;
  const s = summary.data;

  return (
    <>
      <PageHeader title="Texts" description={<>Texts sent to your clients.{retention ? ` Words are kept ${countOf(retention, 'day')}.` : ''}</>} />
      {/* the strip: each count is a filter */}
      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Texts at a glance" data-testid="texts-summary">
        {s ? (
          <>
            <p data-testid="summary-today"><span className="font-medium">Today:</span>{' '}
              <StripLink onClick={() => pick('sent', s.todayDate)} testId="today-sent">{s.today.sent} sent</StripLink> ·{' '}
              <StripLink onClick={() => pick('not_sent', s.todayDate)} testId="today-not-sent" warn={s.today.notSent > 0}>{s.today.notSent} not sent</StripLink></p>
            <p data-testid="summary-week"><span className="font-medium">Last 7 days:</span>{' '}
              <StripLink onClick={() => pick('sent', s.weekFrom)} testId="week-sent">{s.week.sent} sent</StripLink> ·{' '}
              <StripLink onClick={() => pick('not_sent', s.weekFrom)} testId="week-not-sent" warn={s.week.notSent > 0}>{s.week.notSent} not sent</StripLink>
              {/* of those, the ones nobody has handled: the count Today shows, over the same 7 days (SMALL-2) */}
              {s.needsHandling > 0 && <> · <StripLink onClick={() => { pick('needs_handling', s.weekFrom); setKind('refills'); }} testId="needs-handling" warn>{notHandledWords(s.needsHandling)}</StripLink></>}</p>
          </>
        ) : <Skeleton className="h-5 w-72" />}
      </div>
      <Card className="mb-4 space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
          <div className="space-y-1 sm:col-span-2 lg:col-span-1">
            <Label htmlFor="text-search" className="text-xs text-text-muted">Find a text</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
              <Input id="text-search" type="search" className="pl-8" value={text} onChange={(e) => setText(e.target.value)}
                placeholder={terms.patient === 'pet' ? 'Pet, owner, last 4 digits or R-12' : 'Name, last 4 digits or R-12'} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="text-kind" className="text-xs text-text-muted">Kind</Label>
            <Select id="text-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Every kind</option>
              {(Object.keys(TEXT_GROUPS) as TextGroup[]).map((g) => (
                <optgroup key={g} label={TEXT_GROUP_NAMES[g]}>
                  <option value={g}>All: {TEXT_GROUP_NAMES[g].toLowerCase()}</option>
                  {TEXT_GROUPS[g].map((t) => <option key={t} value={t}>{t === 'provider' ? `A ${terms.provider}'s details` : TEXT_KINDS[t]}</option>)}
                </optgroup>
              ))}
            </Select>
          </div>
          <div className="space-y-1"><Label htmlFor="text-from" className="text-xs text-text-muted">From</Label><Input id="text-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="text-to" className="text-xs text-text-muted">To</Label><Input id="text-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented label="Which texts" value={status} onValueChange={setStatus} options={(Object.keys(STATUS) as Status[]).map((v) => ({ value: v, label: STATUS[v] }))} className="max-w-full overflow-x-auto" />
          {filtered && <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button>}
        </div>
      </Card>
      <Card className="overflow-hidden">
        {texts.isPending ? <div className="space-y-2 p-5"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
          : texts.isError ? <p className="p-5 text-sm text-text-muted">The texts did not load. It tries again on its own; open this page again if it does not.</p>
            : !rows.length ? (
              <Empty title={filtered ? 'No texts match' : 'No texts yet'}
                action={filtered ? <Button size="sm" variant="outline" onClick={clear}>Clear filters</Button> : undefined}>
                {filtered
                  ? `Search by ${terms.patient === 'pet' ? 'the pet\'s or owner\'s name' : 'name'}, the last four digits of the number, or a request number like R-12. A number not on file is found by its request or kind.`
                  : 'Confirmations, reminders, refill texts and the texts the assistant sends on a call appear here as they go.'}
              </Empty>
            ) : (
              <>
                <TextRows clinicId={clinicId} texts={rows} timeZone={tz} wordsKeptSince={texts.data?.pages[0]?.wordsKeptSince} canHandle={can('tasks:work')} provider={terms.provider} />
                <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-sm text-text-muted">
                  <span data-testid="texts-shown">{countOf(rows.length, 'text')} shown</span>
                  {texts.hasNextPage
                    ? <Button size="sm" variant="outline" disabled={texts.isFetchingNextPage} onClick={() => void texts.fetchNextPage()}>{texts.isFetchingNextPage ? 'Loading…' : 'Show more'}</Button>
                    : <span>That is all of them.</span>}
                </div>
              </>
            )}
      </Card>
    </>
  );
}

function StripLink({ children, onClick, warn, testId }: { children: React.ReactNode; onClick: () => void; warn?: boolean; testId: string }) {
  return <button type="button" onClick={onClick} data-testid={testId} className={cn('focus-ring rounded underline-offset-2 hover:underline', warn ? 'font-medium text-danger' : 'text-primary')}>{children}</button>;
}
