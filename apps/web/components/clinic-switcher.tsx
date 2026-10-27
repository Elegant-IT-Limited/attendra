// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { Check, ChevronsUpDown, MapPin, PlusSquare, Search, X } from 'lucide-react';
import { Dialog as D, DropdownMenu as M } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { groupClinics, type SwitcherClinic, switcherTitle } from '@/lib/clinics';
import { cn } from '@/lib/utils';

export type { SwitcherClinic } from '@/lib/clinics';
/** An owner's link to the hosting layer's pages (from the plan): a full page load. */
export interface SwitcherLink { href: string; label: string; hint: string }

// the tile's colour comes from the clinic id, from the app's own soft tints, so it is the same everywhere and passes contrast in both themes
const TINTS = ['bg-primary-soft', 'bg-info-soft', 'bg-success-soft', 'bg-warning-soft'];
const tint = (id: string) => TINTS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7) % TINTS.length];
const initials = (name: string) => name.split(/\s+/).map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? '').filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
const SEARCH_FROM = 7;

/** The clinic's initials in a small square. */
export function ClinicTile({ clinic, className }: { clinic: { id: string; name: string }; className?: string }) {
  return <span aria-hidden className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-text', tint(clinic.id), className)}>{initials(clinic.name)}</span>;
}

function Label({ clinic, title }: { clinic: SwitcherClinic; title?: string }) {
  return (
    <span className="min-w-0 flex-1 text-left">
      <span className="block truncate text-base font-medium">{title ?? clinic.name}</span>
      <span className="block truncate text-xs text-text-muted">{clinic.role}</span>
    </span>
  );
}

const row = 'flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-base text-text outline-none data-[highlighted]:bg-surface-sunken hover:bg-surface-sunken focus-visible:bg-surface-sunken max-md:min-h-11';
const head = 'px-2 pt-1 pb-1.5 text-xs font-medium text-text-muted';

/**
 * The clinic this screen is for, at the top of the sidebar and in the phone's header. Opens a
 * menu ("Your clinics", with a check on this one, and a search box past six); picking one hands
 * it to onPick, and the frame opens the same page there and says "Now in {clinic}". An owner on
 * a hosted plan also finds "Add a location" and "Create a new clinic" after a divider, even with
 * one clinic. Someone with one clinic and nothing to add sees just its name. On a phone the menu
 * is a sheet from the bottom.
 */
export function ClinicSwitcher({ current, clinics, grow, onPick, sheet }: {
  current: SwitcherClinic; clinics: SwitcherClinic[]; grow: SwitcherLink[]; onPick: (id: string) => void; sheet?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  // the search box takes the typing as the menu opens (the menu itself focuses first)
  useEffect(() => {
    if (!open || clinics.length < SEARCH_FROM) return;
    const f = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(f);
  }, [open, clinics.length]);

  if (clinics.length < 2 && !grow.length) {
    return <div className="flex min-w-0 items-center gap-2.5 p-1.5" data-testid="clinic-name"><ClinicTile clinic={current} /><Label clinic={current} /></div>;
  }

  const pick = (id: string) => {
    setOpen(false);
    if (id === current.id) return;
    onPick(id);
  };
  const q = query.trim().toLowerCase();
  const shown = q ? clinics.filter((c) => c.name.toLowerCase().includes(q) || c.organizationName?.toLowerCase().includes(q)) : clinics;
  const groups = groupClinics(shown);
  const nested = 'pl-4';
  const searchBox = clinics.length >= SEARCH_FROM && (
    <div className="relative px-1 pb-1">
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
      <input ref={search} type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a clinic" placeholder="Find a clinic"
        // typing stays in the box (the menu would jump to an item); the down arrow goes to the list
        onKeyDown={(e) => {
          if (e.key === 'Escape') return;
          e.stopPropagation();
          if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.closest('[role=menu],[role=dialog]')?.querySelector<HTMLElement>('[role=menuitemradio],[data-clinic]')?.focus(); }
        }}
        className="focus-ring h-9 w-full rounded-md border border-border-strong bg-surface pr-3 pl-8 text-base text-text placeholder:text-text-muted max-md:min-h-11 max-md:text-[16px]" />
    </div>
  );
  const none = q && !shown.length && <p className="px-2 py-1.5 text-sm text-text-muted">No clinic matches.</p>;
  const growRow = (l: SwitcherLink) => {
    const Icon = l.label === 'Add a location' ? MapPin : PlusSquare;
    return <><Icon className="size-4 shrink-0 text-text-muted" aria-hidden /><span className="min-w-0 flex-1"><span className="block">{l.label}</span><span className="block text-xs text-text-muted">{l.hint}</span></span></>;
  };
  const trigger = (
    <button type="button" aria-label={`${switcherTitle(current, clinics)}, ${current.role}: switch clinic`}
      className="focus-ring flex w-full min-w-0 items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-surface-sunken data-[state=open]:bg-surface-sunken">
      <ClinicTile clinic={current} /><Label clinic={current} title={switcherTitle(current, clinics)} /><ChevronsUpDown className="size-4 shrink-0 text-text-muted" aria-hidden />
    </button>
  );

  if (sheet) {
    return (
      <D.Root open={open} onOpenChange={setOpen}>
        <D.Trigger asChild>{trigger}</D.Trigger>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-overlay animate-fade-in" />
          <D.Content aria-describedby={undefined} className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-lg border-t border-border bg-surface-raised pb-[env(safe-area-inset-bottom)] text-text shadow-lg animate-rise-in focus-visible:outline-none">
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <D.Title className="text-sm font-medium text-text-muted">Your clinics</D.Title>
              <D.Close className="focus-ring flex size-11 items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken" aria-label="Close"><X className="size-4" /></D.Close>
            </div>
            <div className="overflow-y-auto px-2 pb-3">
              {searchBox}
              <ul>
                {groups.map((g) => (
                  <li key={g.id}>
                    {g.name && <p className={cn(head, 'pt-2')} data-testid="business">{g.name}</p>}
                    <ul>
                      {g.clinics.map((c) => (
                        <li key={c.id}>
                          <button type="button" data-clinic aria-current={c.id === current.id ? 'true' : undefined} onClick={() => pick(c.id)} className={cn(row, 'focus-ring', g.name && nested)}>
                            <ClinicTile clinic={c} /><Label clinic={c} />{c.id === current.id && <Check className="size-4 shrink-0 text-primary" aria-label="Current" />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              {none}
              <GrowSection grow={grow} head={<><div className="mx-2 my-2 h-px bg-border" /><p className={head}>For owners</p></>}>
                {(l) => <a key={l.href} href={l.href} className={cn(row, 'focus-ring')}>{growRow(l)}</a>}
              </GrowSection>
            </div>
          </D.Content>
        </D.Portal>
      </D.Root>
    );
  }

  return (
    // not modal: the page behind is not hidden from screen readers while the button that opened the menu stays focusable there
    <M.Root modal={false} open={open} onOpenChange={setOpen}>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align="start" sideOffset={6} className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-[var(--radix-dropdown-menu-trigger-width)] min-w-60 overflow-y-auto rounded-lg border border-border bg-surface-raised p-1 text-text shadow-lg animate-rise-in">
          <M.Label className={head}>Your clinics</M.Label>
          {searchBox}
          <M.RadioGroup value={current.id} onValueChange={pick}>
            {groups.map((g) => (
              <M.Group key={g.id}>
                {g.name && <M.Label className={cn(head, 'pt-2')} data-testid="business">{g.name}</M.Label>}
                {g.clinics.map((c) => (
                  <M.RadioItem key={c.id} value={c.id} textValue={c.name} className={cn(row, g.name && nested)}>
                    <ClinicTile clinic={c} /><Label clinic={c} />
                    <M.ItemIndicator><Check className="size-4 text-primary" aria-hidden /></M.ItemIndicator>
                  </M.RadioItem>
                ))}
              </M.Group>
            ))}
          </M.RadioGroup>
          {none}
          <GrowSection grow={grow} head={<><M.Separator className="my-1 h-px bg-border" /><M.Label className={head}>For owners</M.Label></>}>
            {(l) => (
              // an owner's link: the address comes from the plan, never read back from the page
              <M.Item key={l.href} asChild textValue={l.label} className={cn(row, 'items-start')}><a href={l.href}>{growRow(l)}</a></M.Item>
            )}
          </GrowSection>
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

/** "For owners", after a divider: nothing when there is nothing to add. */
function GrowSection({ grow, head, children }: { grow: SwitcherLink[]; head: ReactNode; children: (l: SwitcherLink) => ReactNode }) {
  if (!grow.length) return null;
  return <>{head}{grow.map((l) => children(l))}</>;
}
