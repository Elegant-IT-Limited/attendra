// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { Command } from 'cmdk';
import { Check, ChevronDown } from 'lucide-react';
import { Popover as P } from 'radix-ui';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

/** Every IANA zone this browser knows, with the saved one kept even if it does not. */
function zones(current: string) {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return all.includes(current) || !current ? all : [current, ...all];
}

/** "1:31 PM" in a zone, or null for a name the browser cannot use. */
export function nowIn(zone: string, at = new Date()) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(at); } catch { return null; }
}

/**
 * A searchable list of time zones, showing the time it is now in the chosen one:
 * "Europe/Madrid, now 9:31 PM". It saves the IANA name, as the settings always have.
 */
export function TimeZonePicker({ id, value, onChange, disabled }: { id: string; value: string; onChange: (zone: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setTick(new Date()), 30_000); return () => clearInterval(t); }, []);
  const list = useMemo(() => zones(value), [value]);
  const q = query.trim().toLowerCase().replace(/\s+/g, '_');
  const shown = q ? list.filter((z) => z.toLowerCase().includes(q)) : list;
  const time = nowIn(value, tick);

  return (
    <P.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <P.Trigger asChild disabled={disabled}>
        <button id={id} type="button" role="combobox" aria-expanded={open} aria-haspopup="listbox"
          className="focus-ring flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-left text-base disabled:opacity-50 max-md:h-11">
          <span className="truncate" data-testid="time-zone-value">{value}{time ? `, now ${time}` : ''}</span>
          <ChevronDown className="size-4 shrink-0 text-text-muted" aria-hidden />
        </button>
      </P.Trigger>
      <P.Portal>
        <P.Content align="start" sideOffset={6} className="z-50 w-[var(--radix-popover-trigger-width)] min-w-72 rounded-md border border-border bg-surface-raised text-text shadow-lg animate-rise-in">
          <Command shouldFilter={false} label="Time zones" loop>
            <Command.Input value={query} onValueChange={setQuery} autoFocus placeholder="Search, like Madrid or New York"
              className="h-10 w-full border-b border-border bg-transparent px-3 text-base outline-none placeholder:text-text-muted" />
            <Command.List className="max-h-72 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-4 text-sm text-text-muted">No time zone matches.</Command.Empty>
              {shown.slice(0, 200).map((z) => (
                <Command.Item key={z} value={z} onSelect={() => { onChange(z); setOpen(false); setQuery(''); }}
                  className={cn('flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm data-[selected=true]:bg-surface-sunken')}>
                  <span className="truncate">{z.replace(/_/g, ' ')}</span>
                  <span className="flex items-center gap-2 text-xs text-text-muted">{nowIn(z, tick)}{z === value && <Check className="size-3.5 text-primary" aria-hidden />}</span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
