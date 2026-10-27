// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { Popover as P } from 'radix-ui';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A value picked from one of the clinic's own lists (a specialty, a kind of animal): the
 * arrow, a click or the down key opens every choice, typing narrows them, Enter or a click
 * picks one. Nothing typed is ever kept on its own: the list is the one source of truth.
 * With `onAdd` (owners and managers), a last choice "+ Add a specialty…" adds a new value
 * to the clinic's list and picks it. A value the record already has that is not on the
 * list is kept, shown as "Not on your list", with "Add to the list".
 */
export function Combobox({ id, value, options, onChange, placeholder, required, disabled, label, onAdd, addLabel, error }: {
  id: string;
  value: string;
  /** The list, in the clinic's order. `value` is what is stored; `label` what is shown, when they differ. */
  options: (string | { value: string; label: string })[];
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** For the list's accessible name: "Specialty". */
  label: string;
  /** Adds a value to the clinic's list, resolving to its spelling there; null or absent: pick only. */
  onAdd?: ((value: string) => Promise<string>) | null;
  /** The add choice, without its ellipsis: "Add a specialty". */
  addLabel?: string;
  /** A problem with this field, from the server, shown under it. */
  error?: string | null;
}) {
  const items = [...(!required ? [{ value: '', label: 'None' }] : []), ...options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))];
  const [open, setOpen] = useState(false);
  // what is typed to narrow the list; null when nothing is: the box shows the value picked
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const listId = useId();
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const picked = items.find((i) => i.value && same(i.value, value));
  const stray = !!value.trim() && !picked;
  const shown = query === null ? items : items.filter((i) => i.value && (i.label.toLowerCase().includes(query.trim().toLowerCase()) || i.value.toLowerCase().includes(query.trim().toLowerCase())));
  // the add choice is the last row, after the list
  const rows = shown.length + (onAdd ? 1 : 0);
  const optionId = (i: number) => `${listId}-${i}`;
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  });
  useEffect(() => { if (adding !== null) addInput.current?.focus(); }, [adding]);
  const close = () => { setOpen(false); setQuery(null); };
  const pick = (v: string) => { onChange(v); close(); input.current?.focus(); };
  const startAdding = () => { setAdding(query?.trim() ?? ''); setAddError(null); close(); };
  const choose = (i: number) => (i < shown.length ? pick(shown[i]!.value) : startAdding());
  const show = () => { if (!disabled) { setOpen(true); setActive(Math.max(0, shown.findIndex((i) => same(i.value, value)))); } };
  const add = async (text: string, after?: () => void) => {
    if (!onAdd) return;
    setSaving(true);
    setAddError(null);
    try {
      onChange(await onAdd(text));
      after?.();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'That was not added.');
    } finally {
      setSaving(false);
    }
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { show(); return; }
      setActive((a) => (rows ? (a + (e.key === 'ArrowDown' ? 1 : -1) + rows) % rows : 0));
    } else if (e.key === 'Enter') {
      // only a choice from the list, and never the whole form half filled in
      e.preventDefault();
      if (open && active < rows) choose(active);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close();
    }
  };
  const hintId = `${id}-note`;

  return (
    <div className="space-y-1.5">
      <P.Root open={open && rows > 0} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <P.Anchor asChild>
          <div className="relative">
            <Input ref={input} id={id} role="combobox" aria-expanded={open && rows > 0} aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={open && active < rows ? optionId(active) : undefined}
              aria-describedby={stray || error || addError ? hintId : undefined} aria-invalid={error ? true : undefined}
              autoComplete="off" maxLength={60} required={required} disabled={disabled} value={query ?? picked?.label ?? value} placeholder={placeholder} className="pr-9"
              onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
              onBlur={() => setQuery(null)} onKeyDown={key} onClick={show} />
            <button type="button" tabIndex={-1} disabled={disabled} aria-label="Open the list"
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-text-muted hover:text-text disabled:opacity-50"
              onClick={() => (open ? close() : (show(), input.current?.focus()))}>
              <ChevronDown className="size-4" aria-hidden />
            </button>
          </div>
        </P.Anchor>
        <P.Portal>
          <P.Content align="start" sideOffset={4} onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => { if (input.current?.parentElement?.contains(e.target as Node)) e.preventDefault(); }}
            className="z-[80] max-h-64 w-[var(--radix-popover-trigger-width)] min-w-48 overflow-y-auto rounded-md border border-border bg-surface-raised p-1 shadow-lg">
            <ul id={listId} role="listbox" aria-label={`Choices for ${label.toLowerCase()}`}>
              {shown.map((o, i) => {
                const chosen = same(o.value, value);
                return (
                  <li key={o.value || '(none)'} id={optionId(i)} role="option" aria-selected={chosen}
                    className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-base', i === active && 'bg-surface-sunken', !o.value && 'text-text-muted')}
                    onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.value)}>
                    <Check className={cn('size-4 shrink-0 text-primary', !chosen && 'invisible')} aria-hidden />
                    {o.label}
                  </li>
                );
              })}
              {!shown.length && <li role="presentation" className="px-2 py-1.5 text-sm text-text-muted">Nothing on your list matches.</li>}
              {onAdd && (
                <li id={optionId(shown.length)} role="option" aria-selected={false}
                  className={cn('mt-1 flex cursor-pointer items-center gap-2 rounded-sm border-t border-border px-2 py-1.5 text-base text-primary', active === shown.length && 'bg-surface-sunken')}
                  onMouseEnter={() => setActive(shown.length)} onMouseDown={(e) => e.preventDefault()} onClick={startAdding}>
                  <Plus className="size-4 shrink-0" aria-hidden />
                  {addLabel ?? 'Add to the list'}…
                </li>
              )}
            </ul>
          </P.Content>
        </P.Portal>
      </P.Root>
      {adding !== null && onAdd && (
        // its own Escape: it leaves the adding, never the panel the form is in (components/ui/dialog.tsx)
        <div className="flex items-center gap-2" data-own-escape>
          <Input ref={addInput} aria-label={`New ${label.toLowerCase()}`} maxLength={40} value={adding} disabled={saving} className="h-8"
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void add(adding, () => setAdding(null)); }
              if (e.key === 'Escape') { e.preventDefault(); setAdding(null); setAddError(null); input.current?.focus(); }
            }} />
          <Button type="button" size="sm" loading={saving} onClick={() => void add(adding, () => setAdding(null))}>Add</Button>
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => { setAdding(null); setAddError(null); }}>Cancel</Button>
        </div>
      )}
      {(stray || error || addError) && (
        <div id={hintId} className="space-y-1">
          {/* a value the record already has is never dropped: it is shown, and can join the list */}
          {stray && (
            <p className="flex flex-wrap items-center gap-x-2 text-xs">
              <Badge tone="warn">Not on your list</Badge>
              {onAdd && <button type="button" className="focus-ring rounded-sm font-medium text-primary hover:underline disabled:opacity-50" disabled={saving} onClick={() => void add(value)}>Add to the list</button>}
            </p>
          )}
          {(addError || error) && <p className="text-xs font-medium text-danger">{addError ?? error}</p>}
        </div>
      )}
    </div>
  );
}
