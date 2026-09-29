// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { SlotList } from '@attendra/api/contracts';
import { addDays, type ClinicConfig, localDateOf } from '@attendra/core';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { dayTitle, timeOf } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PickedSlot { providerId: string; startsAt: string }

/**
 * Open times for one visit type, a week at a time, from the same search the
 * assistant uses. Only real openings are offered, so a pick is bookable unless
 * someone takes it first.
 */
export function SlotPicker({ clinicId, clinic, visitTypeId, providerId, from, onFrom, value, onChange, excluding }: {
  clinicId: string;
  clinic: ClinicConfig;
  visitTypeId: string;
  providerId: string | null;
  from: string;
  onFrom: (date: string) => void;
  value: PickedSlot | null;
  onChange: (slot: PickedSlot) => void;
  excluding?: string;
}) {
  const days = 7;
  const today = localDateOf(new Date(), clinic.timezone);
  const slots = useQuery({
    queryKey: ['slots', clinicId, visitTypeId, providerId, from, excluding],
    queryFn: () => api<SlotList>(`/clinics/${clinicId}/appointments/slots?${new URLSearchParams({
      visitTypeId, from, days: String(days), ...(providerId ? { providerId } : {}), ...(excluding ? { excluding } : {}),
    })}`),
  });
  const byDay = new Map<string, SlotList['slots']>();
  // earliest first within a day, whoever the provider: the search returns them provider by provider
  const sorted = [...(slots.data?.slots ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.providerId.localeCompare(b.providerId));
  for (const s of sorted) {
    const d = localDateOf(new Date(s.startsAt), clinic.timezone);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const providerName = (id: string) => clinic.providers.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button type="button" size="sm" variant="outline" disabled={from <= today} onClick={() => onFrom(addDays(from, -days) < today ? today : addDays(from, -days))} aria-label="Earlier week">
          <ChevronLeft /> Earlier
        </Button>
        <p className="text-sm text-muted-foreground">{dayTitle(from, 'short')} to {dayTitle(addDays(from, days - 1), 'short')}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => onFrom(addDays(from, days))} aria-label="Later week">
          Later <ChevronRight />
        </Button>
      </div>
      {slots.isPending ? <Skeleton className="h-40" /> : slots.isError ? (
        <p className="text-sm text-danger">Open times did not load. Try again in a moment.</p>
      ) : byDay.size === 0 ? (
        <Empty title="No open times this week">Try the next week, or another provider.</Empty>
      ) : (
        <div className="max-h-80 space-y-4 overflow-y-auto pr-1" role="radiogroup" aria-label="Open times">
          {[...byDay.entries()].map(([day, list]) => (
            <div key={day} className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{dayTitle(day)}</p>
              <div className="flex flex-wrap gap-2">
                {list.map((s) => {
                  const selected = value?.startsAt === s.startsAt && value.providerId === s.providerId;
                  return (
                    <button key={`${s.providerId}@${s.startsAt}`} type="button" role="radio" aria-checked={selected}
                      onClick={() => onChange({ providerId: s.providerId, startsAt: s.startsAt })}
                      className={cn('rounded-md border px-2.5 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card hover:bg-muted')}>
                      <span className="font-medium tabular-nums">{timeOf(s.startsAt, clinic.timezone)}</span>
                      {!providerId && <span className={cn('block text-xs', selected ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{providerName(s.providerId)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
