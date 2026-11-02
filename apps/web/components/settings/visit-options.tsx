// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type ClinicConfig, noDayPossible } from '@attendra/core';
import { useId, useState } from 'react';
import { Field } from '@/components/settings/section';
import { Switch } from '@/components/ui/controls';
import { Input, Select } from '@/components/ui/input';

type Visit = ClinicConfig['visitTypes'][number];
const num = (v: string) => (v === '' ? undefined : Math.max(0, Math.round(Number(v))));

/**
 * The visit-type settings most clinics never touch, closed by default (open when one is set, so nothing hides a value):
 * who can book it, whether the team books it, the notice and the furthest date (labelled so the two can't be confused,
 * the notice in hours or days as typed), and the minutes kept free after it.
 */
export function VisitMoreOptions({ v, pet, onChange, disabled }: { v: Visit; pet: boolean; onChange: (patch: Partial<Visit>) => void; disabled: boolean }) {
  const id = useId();
  const set = v.audience !== 'all' || !!v.staffOnly || v.noticeHours !== undefined || v.maxDaysAhead !== undefined || !!v.bufferMinutes;
  // the notice is stored in hours and shown in days when it was typed in days (a whole number of days)
  const [unit, setUnit] = useState<'hours' | 'days'>(v.noticeHours && v.noticeHours >= 24 && v.noticeHours % 24 === 0 ? 'days' : 'hours');
  const shown = v.noticeHours === undefined ? '' : unit === 'days' ? String(v.noticeHours / 24) : String(v.noticeHours);
  const name = v.name || 'This visit';
  return (
    <details className="group rounded-md border border-border" open={set || undefined}>
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">More options</summary>
      <div className="space-y-4 border-t border-border px-3 py-3">
        <Field label="Who can book it" htmlFor={`${id}-audience`}>
          <Select id={`${id}-audience`} className="sm:w-72" value={v.audience} onChange={(e) => onChange({ audience: e.target.value as Visit['audience'] })}>
            <option value="all">Anyone</option>
            <option value="new">{pet ? 'New clients only' : 'New patients only'}</option>
            <option value="existing">{pet ? 'Pets already on file' : 'Patients on file only'}</option>
          </Select>
        </Field>
        <Switch id={`staff-only-${v.id}`} label="Team books it" hint="The assistant never offers times for it. It says the team books it (and the notice, when set), and takes a request for the team or books a related visit."
          checked={!!v.staffOnly} onCheckedChange={(on) => onChange({ staffOnly: on || undefined })} disabled={disabled} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Book at least ___ ahead (notice)" htmlFor={`${id}-notice`} hint='For example "Surgery: at least 72 hours ahead". Empty: 2 hours.'>
            <div className="flex gap-2">
              <Input id={`${id}-notice`} type="number" inputMode="numeric" min={0} max={unit === 'days' ? 30 : 720} value={shown} placeholder="2"
                aria-label={`${name}: book at least this far ahead, in ${unit}`} aria-invalid={noDayPossible(v) || undefined} aria-describedby={noDayPossible(v) ? `${id}-nodays` : undefined}
                onChange={(e) => { const n = num(e.target.value); onChange({ noticeHours: n === undefined ? undefined : unit === 'days' ? n * 24 : n }); }} />
              <Select aria-label={`${name}: notice in hours or days`} className="w-28" value={unit} onChange={(e) => setUnit(e.target.value as 'hours' | 'days')}>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </Select>
            </div>
          </Field>
          <Field label="Book at most ___ days ahead (furthest date)" htmlFor={`${id}-furthest`} hint='For example "Vaccines: at most 60 days ahead". Empty: no limit.'>
            <Input id={`${id}-furthest`} type="number" inputMode="numeric" min={1} max={365} value={v.maxDaysAhead ?? ''} placeholder="No limit"
              aria-label={`${name}: book at most this many days ahead`} onChange={(e) => onChange({ maxDaysAhead: num(e.target.value) || undefined })} />
          </Field>
        </div>
        {noDayPossible(v) && (
          <p id={`${id}-nodays`} role="alert" className="text-sm text-danger">
            No day can be booked: the notice ({v.noticeHours} hours) is longer than the furthest date ({v.maxDaysAhead} days). Shorten the notice or allow more days.
          </p>
        )}
        <Field label="Minutes kept free after" htmlFor={`${id}-buffer`} hint="For cleaning or notes, on calls and at the desk.">
          <Input id={`${id}-buffer`} className="sm:w-40" type="number" inputMode="numeric" min={0} max={120} value={v.bufferMinutes ?? ''} placeholder="0"
            aria-label={`${name}: minutes free after`} onChange={(e) => onChange({ bufferMinutes: num(e.target.value) })} />
        </Field>
      </div>
    </details>
  );
}
