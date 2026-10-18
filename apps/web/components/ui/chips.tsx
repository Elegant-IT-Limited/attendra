// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { X } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { Input } from '@/components/ui/input';

/**
 * Several values from a list the clinic keeps, as chips: type to pick one of the
 * suggestions, or a new one (it joins the list when saved). Enter or a comma adds;
 * each chip has its own remove button.
 */
export function ChipsPicker({ id, values, suggestions, onChange, placeholder, label }: {
  id: string; values: string[]; suggestions: string[]; onChange: (values: string[]) => void; placeholder?: string; label: string;
}) {
  const [text, setText] = useState('');
  const listId = useId();
  const add = (raw: string) => {
    const v = raw.trim().replace(/,$/, '').trim();
    if (!v) return;
    // the clinic's own spelling when it is on the list
    const known = suggestions.find((s) => s.toLowerCase() === v.toLowerCase()) ?? v;
    if (!values.some((x) => x.toLowerCase() === known.toLowerCase())) onChange([...values, known]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text); }
    if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
  };
  const left = suggestions.filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()));
  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {values.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 rounded-full bg-primary-soft py-0.5 pl-2.5 pr-1 text-sm text-primary">
              {v}
              <button type="button" className="focus-ring rounded-full p-0.5 hover:bg-primary/10" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><X className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
      <Input id={id} list={listId} value={text} placeholder={placeholder} autoComplete="off" maxLength={40}
        onChange={(e) => { const v = e.target.value; if (left.some((s) => s === v)) add(v); else setText(v); }} onKeyDown={onKey} onBlur={() => add(text)} />
      <datalist id={listId}>{left.map((s) => <option key={s} value={s} />)}</datalist>
      {left.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={`Add from the list: ${label}`}>
          {left.slice(0, 12).map((s) => (
            <button key={s} type="button" className="focus-ring rounded-full border border-border px-2.5 py-0.5 text-sm text-text-muted hover:border-primary hover:text-primary" onClick={() => add(s)}>+ {s}</button>
          ))}
        </div>
      )}
    </div>
  );
}
