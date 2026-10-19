// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { SpecialDay } from '@attendra/core';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { dayTitle } from '@/lib/format';

/**
 * Days whose hours differ from the week's: closed with a reason, or open shorter hours.
 * Each row is a date, closed or open these hours (one or two windows), and a note the
 * assistant says ("Christmas Eve"). Added from the top, kept in date order. A date
 * already a holiday or already listed is refused.
 */
export function SpecialDaysEditor({ days, holidays, onChange }: { days: SpecialDay[]; holidays: string[]; onChange: (days: SpecialDay[]) => void }) {
  const [date, setDate] = useState('');
  // the row just added is kept in date order: bring it into view, outlined, with the cursor in it
  const [added, setAdded] = useState<string | null>(null);
  useEffect(() => {
    if (!added) return;
    const el = document.getElementById(`special-${added}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.querySelector<HTMLElement>('select')?.focus({ preventScroll: true });
    el?.classList.add('ring-2', 'ring-primary');
    // not cleared when `added` resets below: the outline must still come off
    if (el) setTimeout(() => el.classList.remove('ring-2', 'ring-primary'), 1200);
    setAdded(null);
  }, [added, days]);
  const taken = (d: string) => holidays.includes(d) || days.some((x) => x.date === d);
  const upd = (i: number, patch: Partial<SpecialDay>) => onChange(days.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" aria-label="Special day date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
        <Button type="button" variant="outline" disabled={!date || taken(date) || days.length >= 60}
          onClick={() => { onChange([...days, { date, windows: [{ open: '08:00', close: '12:00' }] }].sort((a, b) => a.date.localeCompare(b.date))); setAdded(date); setDate(''); }}>
          <Plus /> Add special day
        </Button>
        {date && taken(date) && <span className="text-sm text-text-muted">This date is already listed.</span>}
      </div>
      {days.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {days.map((d, i) => (
            <li key={d.date} id={`special-${d.date}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
              <span className="w-32 text-base font-medium">{dayTitle(d.date, 'short')} {d.date.slice(0, 4)}</span>
              <Select aria-label={`${d.date}: closed or open`} className="w-48" value={d.windows.length ? 'open' : 'closed'}
                onChange={(e) => upd(i, { windows: e.target.value === 'open' ? [{ open: '08:00', close: '12:00' }] : [] })}>
                <option value="closed">Closed all day</option>
                <option value="open">Open these hours</option>
              </Select>
              {d.windows.map((w, k) => (
                <span key={k} className="flex items-center gap-1.5">
                  <Input type="time" aria-label={`${d.date} opens`} className="w-32" value={w.open} onChange={(e) => upd(i, { windows: d.windows.map((x, j) => (j === k ? { ...x, open: e.target.value } : x)) })} />
                  <span className="text-sm text-text-muted">to</span>
                  <Input type="time" aria-label={`${d.date} closes`} className="w-32" value={w.close} onChange={(e) => upd(i, { windows: d.windows.map((x, j) => (j === k ? { ...x, close: e.target.value } : x)) })} />
                  {d.windows.length > 1 && <Button type="button" size="icon" variant="ghost" className="text-text-muted hover:text-danger" aria-label={`Remove these ${d.date} hours`} onClick={() => upd(i, { windows: d.windows.filter((_, j) => j !== k) })}><Trash2 /></Button>}
                </span>
              ))}
              {d.windows.length === 1 && <Button type="button" size="sm" variant="ghost" onClick={() => upd(i, { windows: [...d.windows, { open: '13:00', close: '17:00' }] })}><Plus /> More hours</Button>}
              <Input aria-label={`${d.date} note`} maxLength={60} className="min-w-40 flex-1" placeholder="Note, like Christmas Eve" value={d.note ?? ''} onChange={(e) => upd(i, { note: e.target.value || undefined })} />
              <Button type="button" size="icon" variant="ghost" className="text-text-muted hover:text-danger" aria-label={`Remove ${d.date}`} onClick={() => onChange(days.filter((_, j) => j !== i))}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
