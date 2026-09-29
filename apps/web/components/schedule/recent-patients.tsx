// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState } from 'react';
import type { PatientChoice } from '@/components/schedule/booking-dialog';
import { Input, Label } from '@/components/ui/input';

/** Pick someone already on the schedule. Patient search replaces this. */
export function RecentPatients({ patients, onPick }: { patients: PatientChoice[]; onPick: (p: PatientChoice) => void }) {
  const [filter, setFilter] = useState('');
  const shown = patients.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="recent-filter">Patient</Label>
        <Input id="recent-filter" autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type part of a name" />
        <p className="text-xs text-muted-foreground">Patients on the schedule you are looking at.</p>
      </div>
      {shown.length === 0 ? <p className="text-sm text-muted-foreground">Nobody on this schedule matches.</p> : (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {shown.map((p) => (
            <li key={p.id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" onClick={() => onPick(p)}>{p.name}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
