// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type ClinicConfig, managedList, providerName } from '@attendra/core';
import { Users } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Input, Label, Select } from '@/components/ui/input';
import { Popover } from '@/components/ui/overlay';
import { MAX_CHOSEN, worksOn } from '@/lib/schedule-lanes';

type Provider = ClinicConfig['providers'][number];

/**
 * Which lanes a big clinic's grid draws first ("My vets"): up to MAX_CHOSEN providers, found by name,
 * narrowed by specialty or to the ones working on the day shown; the grid fills the rest of its MAX_CHOSEN
 * lanes with the others in use (capLanes). The choice applies at
 * once and is kept in this browser for this clinic (lib/schedule-lanes.ts).
 */
export function VetsPicker({ clinic, providers, date, chosen, onChange, word, onGrid }: {
  clinic: ClinicConfig;
  /** The providers the Schedule lists, in its order. */
  providers: Provider[];
  /** The day on screen, for "Working today". */
  date: string;
  chosen: string[];
  onChange: (ids: string[]) => void;
  /** What the clinic calls them: "veterinarians" or "providers". */
  word: string;
  /** How many have a lane on the grid now, for "Choose vets (8 of 101)". */
  onGrid: number;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [workingOnly, setWorkingOnly] = useState(false);
  // said next to the list when a ninth is ticked, until something changes
  const [full, setFull] = useState(false);
  const specialties = managedList(clinic, 'specialties');
  const q = query.trim().toLowerCase();
  const shown = providers.filter((p) => (!q || providerName(p).toLowerCase().includes(q))
    && (!specialty || (p.specialty ?? '').toLowerCase() === specialty.toLowerCase())
    && (!workingOnly || worksOn(clinic, p, date)));
  const toggle = (pid: string, on: boolean) => {
    if (!on) { setFull(false); onChange(chosen.filter((x) => x !== pid)); return; }
    if (chosen.length >= MAX_CHOSEN) { setFull(true); return; }
    setFull(false);
    onChange([...chosen, pid]);
  };
  const one = word.replace(/s$/, '');

  return (
    <Popover className="w-80 p-3" trigger={
      <Button variant="outline" size="sm" aria-label={`Choose ${word === 'veterinarians' ? 'vets' : 'providers'}: ${onGrid} of ${providers.length} on the grid${chosen.length ? `, ${chosen.length} in My ${word === 'veterinarians' ? 'vets' : 'providers'}` : ''}`}>
        <Users /> Choose {word === 'veterinarians' ? 'vets' : 'providers'} <span className="tabular-nums text-text-muted">({onGrid} of {providers.length})</span>
      </Button>
    }>
      <div className="space-y-3" data-testid="vets-picker">
        <div>
          <p className="text-sm font-medium">My {word === 'veterinarians' ? 'vets' : 'providers'}</p>
          <p className="text-xs text-text-muted">The grid shows up to {MAX_CHOSEN} {word}: yours first, then the others with visits. Pick up to {MAX_CHOSEN}; they are saved as My {word === 'veterinarians' ? 'vets' : 'providers'} in this browser. The Agenda lists everyone.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-find`} className="sr-only">Find a {one}</Label>
          <Input id={`${id}-find`} type="search" className="h-8" placeholder="Find by name" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {specialties.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor={`${id}-specialty`} className="sr-only">Specialty</Label>
            <Select id={`${id}-specialty`} className="h-8" value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
              <option value="">Every specialty</option>
              {specialties.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
        )}
        <Checkbox id={`${id}-working`} label="Working today" checked={workingOnly} onCheckedChange={setWorkingOnly} />
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span aria-live="polite">{chosen.length} of {MAX_CHOSEN} chosen</span>
          {chosen.length > 0 && <button type="button" className="focus-ring rounded-sm font-medium text-primary hover:underline" onClick={() => { setFull(false); onChange([]); }}>Clear</button>}
        </div>
        {full && <p className="text-xs font-medium text-danger" role="alert">That is {MAX_CHOSEN} already. Untick one to add another.</p>}
        <ul className="-mx-1 max-h-64 space-y-0.5 overflow-y-auto px-1" aria-label={`${word.charAt(0).toUpperCase()}${word.slice(1)} to show`}>
          {shown.map((p) => (
            <li key={p.id} className="rounded-sm px-1 py-1 hover:bg-surface-sunken">
              <Checkbox id={`${id}-${p.id}`} checked={chosen.includes(p.id)} onCheckedChange={(on) => toggle(p.id, on)}
                label={<span className="font-normal">{providerName(p)}</span>}
                hint={[p.specialty, worksOn(clinic, p, date) ? '' : 'Not working today'].filter(Boolean).join(', ') || undefined} />
            </li>
          ))}
          {!shown.length && <li className="px-1 py-2 text-sm text-text-muted">No {one} matches.</li>}
        </ul>
      </div>
    </Popover>
  );
}
