// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { Check, ChevronDown } from 'lucide-react';
import { Popover as P } from 'radix-ui';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A field that is a dropdown of the clinic's own list and also takes a new value typed
 * in: the arrow, a click or the down key opens every choice (not only the ones that
 * match what is already there), typing narrows them, Enter or a click picks one.
 * Used wherever a value comes from a managed list (a specialty, a kind of animal).
 */
export function Combobox({ id, value, options, onChange, placeholder, maxLength = 60, required, disabled, label }: {
  id: string;
  value: string;
  /** The list, in the clinic's order. `value` is what is stored; `label` what is shown, when they differ. */
  options: (string | { value: string; label: string })[];
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  required?: boolean;
  disabled?: boolean;
  /** For the list's accessible name: "Specialty". */
  label: string;
}) {
  const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const q = value.trim().toLowerCase();
  // just opened, or the field holds one of the choices: every choice; typing: the ones that match
  const shown = !typed || items.some((i) => i.value.toLowerCase() === q || i.label.toLowerCase() === q)
    ? items : items.filter((i) => i.label.toLowerCase().includes(q) || i.value.toLowerCase().includes(q));
  const pick = (v: string) => { onChange(v); setOpen(false); setTyped(false); input.current?.focus(); };
  const show = () => { if (!disabled && items.length) { setOpen(true); setTyped(false); setActive(Math.max(0, items.findIndex((i) => i.value.toLowerCase() === q))); } };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { show(); return; }
      setActive((a) => (shown.length ? (a + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length : 0));
    } else if (e.key === 'Enter' && open && shown[active]) {
      e.preventDefault();
      pick(shown[active]!.value);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <P.Root open={open && shown.length > 0} onOpenChange={setOpen}>
      <P.Anchor asChild>
        <div className="relative">
          <Input ref={input} id={id} role="combobox" aria-expanded={open && shown.length > 0} aria-controls={listId} aria-autocomplete="list"
            autoComplete="off" maxLength={maxLength} required={required} disabled={disabled} value={value} placeholder={placeholder} className="pr-9"
            onChange={(e) => { onChange(e.target.value); setTyped(true); setOpen(true); setActive(0); }}
            onKeyDown={key} onClick={show} />
          <button type="button" tabIndex={-1} disabled={disabled} aria-label="Open the list"
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-text-muted hover:text-text disabled:opacity-50"
            onClick={() => (open ? setOpen(false) : (show(), input.current?.focus()))}>
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
              const chosen = o.value.toLowerCase() === q;
              return (
                <li key={o.value} role="option" aria-selected={chosen}
                  className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-base', i === active && 'bg-surface-sunken')}
                  onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.value)}>
                  <Check className={cn('size-4 shrink-0 text-primary', !chosen && 'invisible')} aria-hidden />
                  {o.label}
                </li>
              );
            })}
          </ul>
          <p className="px-2 pt-1 text-xs text-text-muted">Or type a new one.</p>
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
