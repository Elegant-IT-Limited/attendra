// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { Plus, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Several values from a list the clinic keeps, as chips: the list's values are buttons
 * under the box, and typing narrows them (Enter adds the first that matches). Nothing
 * typed is kept on its own. With `onAdd` (owners and managers) a last button adds a new
 * value to the clinic's list and picks it. A value the record already has that is not on
 * the list stays, marked "Not on your list", with "Add to the list".
 */
export function ChipsPicker({ id, values, suggestions, onChange, placeholder, label, onAdd, addLabel, error }: {
  id: string; values: string[]; suggestions: string[]; onChange: (values: string[]) => void; placeholder?: string; label: string;
  /** Adds a value to the clinic's list, resolving to its spelling there; null or absent: pick only. */
  onAdd?: ((value: string) => Promise<string>) | null;
  /** The add button, without its ellipsis: "Add one to the list". */
  addLabel?: string;
  /** A problem with this field, from the server, shown under it. */
  error?: string | null;
}) {
  const [text, setText] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (adding !== null) addInput.current?.focus(); }, [adding]);
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const onTheList = (v: string) => suggestions.some((s) => same(s, v));
  // the values as they are now: a value added to the list arrives after a save, when others may have been picked meanwhile
  const latest = useRef(values);
  latest.current = values;
  const pick = (v: string) => { const now = latest.current; if (!now.some((x) => same(x, v))) onChange([...now, v]); setText(''); };
  const left = suggestions.filter((s) => !values.some((v) => same(v, s)));
  const q = text.trim().toLowerCase();
  const shown = q ? left.filter((s) => s.toLowerCase().includes(q)) : left;
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      // only a value on the list: the one typed exactly, else the first that matches
      e.preventDefault();
      const match = shown.find((s) => same(s, text)) ?? shown[0];
      if (q && match) pick(match);
    }
    if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
  };
  const add = async (raw: string, after?: (spelled: string) => void) => {
    if (!onAdd) return;
    setSaving(true);
    setAddError(null);
    try {
      const spelled = await onAdd(raw);
      after?.(spelled);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'That was not added.');
    } finally {
      setSaving(false);
    }
  };
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {values.map((v) => {
            const stray = !onTheList(v);
            return (
              <li key={v} className={cn('inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-sm', stray ? 'border border-dashed border-border-strong text-text' : 'bg-primary-soft text-primary')}>
                {v}
                {/* a value the record already has is never dropped: it is marked, and can join the list */}
                {stray && <Badge tone="warn">Not on your list</Badge>}
                {stray && onAdd && (
                  <button type="button" className="focus-ring rounded-sm px-1 text-xs font-medium text-primary hover:underline disabled:opacity-50" disabled={saving}
                    onClick={() => void add(v, (spelled) => onChange(latest.current.map((x) => (x === v ? spelled : x))))}>Add to the list</button>
                )}
                <button type="button" className="focus-ring rounded-full p-0.5 hover:bg-primary/10" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><X className="size-3.5" /></button>
              </li>
            );
          })}
        </ul>
      )}
      <Input id={id} role="combobox" aria-expanded={false} aria-autocomplete="list" value={text} placeholder={placeholder} autoComplete="off" maxLength={40}
        aria-describedby={error || addError ? errorId : undefined} aria-invalid={error ? true : undefined}
        onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      {(shown.length > 0 || onAdd || q) && (
        <div className="flex flex-wrap gap-1.5" aria-label={`Add from the list: ${label}`}>
          {shown.map((s) => (
            <button key={s} type="button" className="focus-ring rounded-full border border-border px-2.5 py-0.5 text-sm text-text-muted hover:border-primary hover:text-primary" onClick={() => pick(s)}>+ {s}</button>
          ))}
          {q && !shown.length && <span className="py-0.5 text-sm text-text-muted">Nothing on your list matches.</span>}
          {onAdd && adding === null && (
            <button type="button" className="focus-ring inline-flex items-center gap-1 rounded-full border border-dashed border-primary px-2.5 py-0.5 text-sm text-primary hover:bg-primary-soft"
              onClick={() => { setAdding(text.trim()); setAddError(null); setText(''); }}>
              <Plus className="size-3.5" aria-hidden />{addLabel ?? 'Add one to the list'}…
            </button>
          )}
        </div>
      )}
      {adding !== null && onAdd && (
        // its own Escape: it leaves the adding, never the panel the form is in (components/ui/dialog.tsx)
        <div className="flex items-center gap-2" data-own-escape>
          <Input ref={addInput} aria-label={`New value for ${label.toLowerCase()}`} maxLength={40} value={adding} disabled={saving} className="h-8"
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void add(adding, (spelled) => { pick(spelled); setAdding(null); }); }
              if (e.key === 'Escape') { e.preventDefault(); setAdding(null); setAddError(null); }
            }} />
          <Button type="button" size="sm" loading={saving} onClick={() => void add(adding, (spelled) => { pick(spelled); setAdding(null); })}>Add</Button>
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => { setAdding(null); setAddError(null); }}>Cancel</Button>
        </div>
      )}
      {(addError || error) && <p id={errorId} className="text-xs font-medium text-danger">{addError ?? error}</p>}
    </div>
  );
}
