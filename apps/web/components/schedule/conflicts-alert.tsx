// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { ScheduleConflicts } from '@attendra/api/contracts';
import { localDateOf } from '@attendra/core';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Alert } from '@/components/ui/feedback';
import { api, useClinic, useClinicConfig } from '@/lib/api';
import { dayTitle } from '@/lib/format';

/**
 * Visits still booked on a day their vet or doctor is away, or the clinic is closed for
 * a holiday: a change to days off or holidays never moves anyone, so the team is told.
 */
export function ConflictsAlert({ clinicId, className }: { clinicId: string; className?: string }) {
  const { can } = useClinic(clinicId);
  const config = useClinicConfig(clinicId);
  const q = useQuery({ queryKey: ['schedule-conflicts', clinicId], queryFn: () => api<ScheduleConflicts>(`/clinics/${clinicId}/appointments/conflicts`), enabled: can('schedule:read'), refetchInterval: 60_000 });
  const list = q.data?.conflicts ?? [];
  if (!list.length || !config.data) return null;
  const name = (id: string) => config.data!.providers.find((p) => p.id === id)?.name ?? 'Someone no longer listed';
  const total = list.reduce((n, c) => n + c.count, 0);
  const today = localDateOf(new Date(), config.data.timezone);
  return (
    <Alert tone="warn" className={className} title={`${total} booked ${total === 1 ? 'visit is' : 'visits are'} on a day off or a holiday`}>
      <p className="mb-2">Changing days off or holidays never moves a booking. Move these or call the owners.</p>
      <ul className="space-y-1">
        {list.slice(0, 6).map((c) => (
          <li key={`${c.date}-${c.providerId}`}>
            <Link className="font-medium underline" href={`/c/${clinicId}/schedule?date=${c.date}`}>{c.date === today ? 'Today' : dayTitle(c.date, 'short')}</Link>
            {': '}{c.count} with {name(c.providerId)}, {c.reason === 'holiday' ? 'a holiday' : 'away that day'}
          </li>
        ))}
        {list.length > 6 && <li>and {list.length - 6} more days</li>}
      </ul>
    </Alert>
  );
}
