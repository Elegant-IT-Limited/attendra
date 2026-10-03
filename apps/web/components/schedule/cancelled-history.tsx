// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { CancelledList } from '@attendra/api/contracts';
import { addDays, type ClinicConfig, localDateOf } from '@attendra/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bot, Search, User } from 'lucide-react';
import { useState } from 'react';
import { useSettled } from '@/components/patients/patient-search';
import { capital } from '@/components/schedule/booking-dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Label, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { CANCEL_REASONS, clinicTime, dayTitle, timeOf } from '@/lib/format';

const SORTS = {
  'cancelled-newest': { label: 'Cancelled most recently', sort: 'cancelled', order: 'newest' },
  'cancelled-oldest': { label: 'Cancelled longest ago', sort: 'cancelled', order: 'oldest' },
  'visit-newest': { label: 'Visit date, latest first', sort: 'visit', order: 'newest' },
  'visit-oldest': { label: 'Visit date, earliest first', sort: 'visit', order: 'oldest' },
} as const;
type SortKey = keyof typeof SORTS;

/**
 * Cancelled visits only, as a history: what was due in a window of days, who cancelled
 * it, why and when, sorted as the front desk needs. A row opens the visit.
 */
export function CancelledHistory({ clinicId, clinic, providerId, onOpen }: { clinicId: string; clinic: ClinicConfig; providerId: string; onOpen: (id: string) => void }) {
  const today = localDateOf(new Date(), clinic.timezone);
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(addDays(today, 30));
  const [sort, setSort] = useState<SortKey>('cancelled-newest');
  const [text, setText] = useState('');
  const q = useSettled(text.trim());
  // a POST body: the name typed is a patient's, and never goes in an address
  const body = { from, to, sort: SORTS[sort].sort, order: SORTS[sort].order, ...(providerId ? { providerId } : {}), ...(q ? { q } : {}) };
  const list = useQuery({
    queryKey: ['cancelled', clinicId, from, to, sort, providerId, q],
    queryFn: () => api<CancelledList>(`/clinics/${clinicId}/appointments/cancelled`, { method: 'POST', body: JSON.stringify(body) }),
    enabled: !!from && !!to && from <= to,
    placeholderData: keepPreviousData,
  });
  const provider = (id: string) => clinic.providers.find((p) => p.id === id)?.name ?? 'A former provider';
  const visit = (id: string) => clinic.visitTypes.find((v) => v.id === id)?.name ?? 'visit';
  const tz = clinic.timezone;

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3 text-sm">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="cancelled-from" className="text-text-muted">Visits from</Label>
          <Input id="cancelled-from" type="date" className="h-8 w-38" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          <Label htmlFor="cancelled-to" className="text-text-muted">to</Label>
          <Input id="cancelled-to" type="date" className="h-8 w-38" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cancelled-sort" className="sr-only">Sort</Label>
          <Select id="cancelled-sort" className="h-8 w-56" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </div>
        <div className="relative min-w-48 flex-1">
          <Label htmlFor="cancelled-search" className="sr-only">Find a patient</Label>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <Input id="cancelled-search" type="search" className="h-8 pl-8" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder="Patient name" />
        </div>
      </div>
      {list.isError && <Alert tone="danger" className="m-4">This list did not load. Try again in a moment.</Alert>}
      {list.isPending ? <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        : !list.data?.appointments.length ? <Empty title="No cancelled visits">Nothing due between {dayTitle(from)} and {dayTitle(to)} was cancelled{q ? ' for that name' : ''}.</Empty>
          : (
            <ul className="divide-y divide-border" aria-label="Cancelled visits" aria-busy={list.isFetching}>
              {list.data.appointments.map((a) => {
                const Icon = a.cancelledBy?.kind === 'assistant' ? Bot : User;
                return (
                  <li key={a.id}>
                    <button type="button" onClick={() => onOpen(a.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left text-sm hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none">
                      <span className="w-52 shrink-0">
                        <span className="block font-medium line-through decoration-text-muted">{dayTitle(localDateOf(new Date(a.startsAt), tz))}, {timeOf(a.startsAt, tz)}</span>
                        <span className="block text-xs text-text-muted">{capital(visit(a.visitTypeId))} with {provider(a.providerId)}</span>
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{a.patientName}</span>
                      <span className="text-text-muted">{a.cancelReason ? CANCEL_REASONS[a.cancelReason] : 'No reason given'}</span>
                      <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                        <Icon className="size-3.5" aria-hidden />
                        {a.cancelledBy?.kind === 'assistant' ? 'The assistant' : (a.cancelledBy?.name ?? 'Staff')}, {clinicTime(a.cancelledAt, tz)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
      {list.data?.truncated && <p className="px-4 py-2 text-xs text-text-muted">Showing the first 200. Narrow the dates or type a name.</p>}
    </div>
  );
}
