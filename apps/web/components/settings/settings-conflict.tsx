// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/dialog';
import { Select } from '@/components/ui/input';
import { type Change, changes, merge } from '@/lib/merge';

export interface Conflict<T> { theirs: T; version: number; updatedAt: string | null; updatedBy: { name: string } | null }

const WHO: Record<Exclude<Change, 'same'>, (name: string) => string> = { mine: () => 'changed by you', theirs: (n) => `changed by ${n}`, both: () => 'changed by both of you' };

/**
 * Someone saved Settings while this page was open: a dialog in the middle of the
 * screen says which sections each of you changed, and lets you take their version or
 * keep yours where it does not clash (choosing per section where you both changed the
 * same one). Closing it keeps your changes. Nothing is saved until Save changes.
 */
export function SettingsConflict<T extends object>({ base, mine, conflict, label, timeLabel, onResolved }: {
  base: T; mine: T; conflict: Conflict<T>; label: (key: string) => string; timeLabel: (iso: string) => string;
  onResolved: (next: T) => void;
}) {
  const found = changes(base, mine, conflict.theirs);
  const name = conflict.updatedBy?.name ?? 'Someone';
  const shown = Object.entries(found).filter(([, c]) => c !== 'same') as [string, Exclude<Change, 'same'>][];
  const [pick, setPick] = useState<Record<string, 'mine' | 'theirs'>>({});
  // several keys can be one section (two emergency hospital keys): one line per section
  const sections = new Map<string, Exclude<Change, 'same'>>();
  for (const [k, c] of shown) sections.set(label(k), sections.has(label(k)) && sections.get(label(k)) !== c ? 'both' : c);
  const clashes = shown.filter(([, c]) => c === 'both').map(([k]) => k);
  const keepMine = () => onResolved(merge(mine, conflict.theirs, found, (k) => (pick[k] ?? 'mine') === 'mine'));

  return (
    <Panel open onOpenChange={(open) => { if (!open) keepMine(); }} className="max-w-xl"
      title={`${name} saved Settings${conflict.updatedAt ? ` at ${timeLabel(conflict.updatedAt)}` : ''} while you were editing`}
      description="Your changes are not saved yet. Choose what to keep, then check the page and press Save changes."
      footer={<>
        <Button variant="outline" onClick={() => onResolved(conflict.theirs)}>Load their version</Button>
        <Button onClick={keepMine}>Keep my changes{clashes.length ? ' as chosen' : ''}</Button>
      </>}>
      {sections.size > 0 && (
        <ul className="list-disc space-y-1 pl-4">
          {[...sections].map(([section, c]) => <li key={section}><span className="font-medium">{section}</span>: {WHO[c](name)}</li>)}
        </ul>
      )}
      {clashes.length > 0 && (
        <div className="mt-3 space-y-2">
          <p>You both changed {clashes.length === 1 ? 'this' : 'these'}. Choose whose to keep:</p>
          {clashes.map((k) => (
            <label key={k} className="flex flex-wrap items-center gap-2">
              <span className="w-44 font-medium">{label(k)}</span>
              <Select className="h-8 w-40" value={pick[k] ?? 'mine'} onChange={(e) => setPick({ ...pick, [k]: e.target.value as 'mine' | 'theirs' })}>
                <option value="mine">Mine</option>
                <option value="theirs">{name}&apos;s</option>
              </Select>
            </label>
          ))}
        </div>
      )}
    </Panel>
  );
}
