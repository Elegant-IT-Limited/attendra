// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { SlotList } from '@attendra/api/contracts';
import { addDays, type ClinicConfig, localDateOf, providerName } from '@attendra/core';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { api, BUSY, isBusy } from '@/lib/api';
import { gridLabel, upcomingSlots } from '@/lib/booking';
import { usePets } from '@/lib/terms';
import { dayTitle, timeOf } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PickedSlot { providerId: string; startsAt: string }

/**
 * Open times for one visit type, a week at a time, from the same search the
 * assistant uses. Only real openings are offered, so a pick is bookable unless
 * someone takes it first.
 */
export function SlotPicker({ clinicId, clinic, visitTypeId, providerId, from, onFrom, value, onChange, excluding, patientId }: {
  clinicId: string;
  clinic: ClinicConfig;
  visitTypeId: string;
  providerId: string | null;
  from: string;
  onFrom: (date: string) => void;
  value: PickedSlot | null;
  onChange: (slot: PickedSlot) => void;
  excluding?: string;
  /** Who the visit is for: "anyone" then means anyone who sees them. */
  patientId?: string;
}) {
  const days = 7;
  const pets = usePets(clinicId);
  const today = localDateOf(new Date(), clinic.timezone);
  const slots = useQuery({
    queryKey: ['slots', clinicId, visitTypeId, providerId, from, excluding, patientId],
    queryFn: () => api<SlotList>(`/clinics/${clinicId}/appointments/slots?${new URLSearchParams({
      visitTypeId, from, days: String(days), ...(providerId ? { providerId } : {}), ...(excluding ? { excluding } : {}), ...(patientId ? { patientId } : {}),
    })}`),
  });
  const byDay = new Map<string, SlotList['slots']>();
  // never a time sooner than the lead time, however long ago the list loaded (the desk was offered 10:00 AM at 10:20)
  const shown = upcomingSlots(slots.data?.slots ?? [], new Date(), slots.data?.leadMinutes ?? 0);
  // earliest first within a day, whoever the provider: the search returns them provider by provider
  const sorted = [...shown].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.providerId.localeCompare(b.providerId));
  for (const s of sorted) {
    const d = localDateOf(new Date(s.startsAt), clinic.timezone);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const nameOf = (id: string) => { const p = clinic.providers.find((x) => x.id === id); return p ? providerName(p) : id; };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button type="button" size="sm" variant="outline" disabled={from <= today} onClick={() => onFrom(addDays(from, -days) < today ? today : addDays(from, -days))} aria-label="Earlier week">
          <ChevronLeft /> Earlier
        </Button>
        <p className="text-sm text-text-muted">{dayTitle(from, 'short')} to {dayTitle(addDays(from, days - 1), 'short')}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => onFrom(addDays(from, days))} aria-label="Later week">
          Later <ChevronRight />
        </Button>
      </div>
      {slots.data?.startEvery && slots.data.leadMinutes !== undefined && <p className="text-xs text-text-muted" data-testid="slot-grid">{gridLabel(slots.data.startEvery, slots.data.leadMinutes)}</p>}
      {slots.isPending ? <Skeleton className="h-40" /> : slots.isError ? (
        <p className="text-sm text-danger">{isBusy(slots.error) ? BUSY : 'Open times did not load. Try again in a moment.'}</p>
      ) : byDay.size === 0 ? (
        <Empty title="No open times this week">Try the next week, or another {pets ? 'veterinarian' : 'provider'}.</Empty>
      ) : (
        <div className="max-h-80 space-y-4 overflow-y-auto pr-1" role="radiogroup" aria-label="Open times">
          {[...byDay.entries()].map(([day, list]) => (
            <div key={day} className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{dayTitle(day)}</p>
              {providerId ? (
                // one provider chosen: its times, one button each
                <div className="flex flex-wrap gap-2">
                  {list.map((s) => <SlotButton key={`${s.providerId}@${s.startsAt}`} slot={s} label={timeOf(s.startsAt, clinic.timezone)} value={value} onChange={onChange} />)}
                </div>
              ) : (
                // anyone: one row per time with whoever is free at it, never the same time repeated for each (note 52 C6)
                <ul className="space-y-1.5" data-testid="slot-rows">
                  {byTime(list).map(([startsAt, same]) => {
                    const time = timeOf(startsAt, clinic.timezone);
                    return (
                      <li key={startsAt} className="flex items-start gap-3">
                        <span className="w-[4.75rem] shrink-0 pt-1.5 text-sm font-medium tabular-nums">{time}</span>
                        <div className="flex min-w-0 flex-wrap gap-1.5">
                          {same.map((s) => <SlotButton key={`${s.providerId}@${s.startsAt}`} slot={s} label={nameOf(s.providerId)} aria={`${time} with ${nameOf(s.providerId)}`} value={value} onChange={onChange} />)}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The slots of one day by start time, in order: each time once, with the providers free at it. */
function byTime(list: SlotList['slots']): [string, SlotList['slots']][] {
  const out = new Map<string, SlotList['slots']>();
  for (const s of list) out.set(s.startsAt, [...(out.get(s.startsAt) ?? []), s]);
  return [...out.entries()];
}

/** One open time to pick: a radio, with the start it books on it for the tests and the desk's own checks. */
function SlotButton({ slot, label, aria, value, onChange }: { slot: SlotList['slots'][number]; label: string; aria?: string; value: PickedSlot | null; onChange: (slot: PickedSlot) => void }) {
  const selected = value?.startsAt === slot.startsAt && value.providerId === slot.providerId;
  return (
    <button type="button" role="radio" aria-checked={selected} aria-label={aria} data-starts-at={slot.startsAt}
      onClick={() => onChange({ providerId: slot.providerId, startsAt: slot.startsAt })}
      className={cn('max-w-full truncate rounded-md border px-2.5 py-1.5 text-left text-sm focus-ring',
        selected ? 'border-primary bg-primary text-on-primary' : 'border-border-strong bg-surface hover:bg-surface-sunken')}>
      <span className={aria ? undefined : 'font-medium tabular-nums'}>{label}</span>
    </button>
  );
}
