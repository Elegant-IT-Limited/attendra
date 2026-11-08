// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { StrandedVisits } from '@attendra/api/contracts';
import { type ClinicConfig, localDateOf, providerName } from '@attendra/core';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/dialog';
import { ApiFailure } from '@/lib/api';
import { dayTitle, timeOf } from '@/lib/format';

/** Why each visit would be left out, as the list says it. */
export const STRANDED_WHY: Record<StrandedVisits['visits'][number]['reason'], string> = {
  outside_hours: 'outside the new hours',
  holiday: 'the clinic would be closed',
  away: 'away then',
};

/** The "move or keep" list in a failed save, when that is why it failed (a 409 strands_visits). */
export function strandedOf(e: unknown): StrandedVisits | null {
  return e instanceof ApiFailure && e.status === 409 && e.body.error === 'strands_visits' ? (e.body as unknown as StrandedVisits) : null;
}

/** The address of one visit's reschedule: its day on the Schedule, its panel open on Reschedule. */
export const moveHref = (clinicId: string, timeZone: string, v: Pick<StrandedVisits['visits'][number], 'appointmentId' | 'startsAt'>) =>
  `/c/${clinicId}/schedule?${new URLSearchParams({ view: 'day', date: localDateOf(new Date(v.startsAt), timeZone), appointment: v.appointmentId, move: '1' })}`;

/**
 * Before a change of hours, a vet's hours or days off, a holiday or a special day is saved: the booked visits it would
 * leave outside any bookable time (when, with whom, which pet), so nothing is stranded silently. Keep saves the change
 * and leaves the visits as they are (the server audits it); each Move opens that visit's reschedule in a new tab, so
 * the change on this page is not lost, and saving again lists only what is still left.
 */
export function StrandedDialog({ clinicId, clinic, stranded, pending, onKeep, onClose }: {
  clinicId: string;
  clinic: Pick<ClinicConfig, 'timezone' | 'providers'>;
  stranded: StrandedVisits | null;
  pending?: boolean;
  onKeep: () => void;
  onClose: () => void;
}) {
  const visits = stranded?.visits ?? [];
  const n = visits.length;
  const tz = clinic.timezone;
  const vet = (id: string) => { const p = clinic.providers.find((x) => x.id === id); return p ? providerName(p) : 'Someone no longer listed'; };
  return (
    <Panel open={!!stranded} onOpenChange={(open) => { if (!open) onClose(); }} stacked className="max-w-xl"
      title={`${n} booked ${n === 1 ? 'visit' : 'visits'} would be left outside the hours`}
      description="Nothing is saved yet. Move them to a time that still works, or keep them where they are and save."
      footer={<>
        <Button variant="outline" onClick={onClose}>Go back</Button>
        <Button onClick={onKeep} disabled={pending}>{pending ? 'Saving…' : `Keep ${n === 1 ? 'it' : 'them'} and save`}</Button>
      </>}>
      <ul className="divide-y divide-border" aria-label="Visits left outside the hours" data-testid="stranded-visits">
        {visits.map((v) => (
          <li key={v.appointmentId} className="flex items-center gap-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{v.patientName || 'Booked visit'}</span>
              <span className="block text-xs text-text-muted">
                {dayTitle(localDateOf(new Date(v.startsAt), tz), 'short')}, {timeOf(v.startsAt, tz)} with {vet(v.providerId)}: {STRANDED_WHY[v.reason]}
              </span>
            </span>
            <Link href={moveHref(clinicId, tz, v)} target="_blank" rel="noopener"
              className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border-strong px-3 text-sm font-medium hover:bg-surface-sunken">
              Move<span className="sr-only"> {v.patientName || 'this visit'} (opens in a new tab)</span><ExternalLink className="size-3.5" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
