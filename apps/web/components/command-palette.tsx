// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { PatientList } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { CalendarPlus, Keyboard, Mic, Monitor, Moon, Search, Sun, User } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Kbd } from '@/components/ui/bits';
import { api } from '@/lib/api';
import { dob } from '@/lib/format';
import type { NavItem } from '@/lib/nav';
import { useTheme } from '@/lib/theme';

const item = 'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-base text-text aria-selected:bg-surface-sunken data-[disabled=true]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-muted max-md:min-h-11';
const group = '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-text-muted';

/**
 * Cmd+K or Ctrl+K: jump anywhere, find a patient, start a booking or a test call,
 * switch the theme. Patient search is the same POST the Patients page makes, so it
 * is audited the same way and what is typed stays out of the address bar.
 */
export function CommandPalette({ clinicId, open, onOpenChange, pages, canSearchPatients, canBook, canTestCall, onShortcuts }: {
  clinicId: string; open: boolean; onOpenChange: (o: boolean) => void; pages: NavItem[];
  canSearchPatients: boolean; canBook: boolean; canTestCall: boolean; onShortcuts: () => void;
}) {
  const router = useRouter();
  const theme = useTheme();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  useEffect(() => { if (!open) { setText(''); setQuery(''); } }, [open]);
  const searching = canSearchPatients && query.length >= 2;
  const patients = useQuery({
    queryKey: ['patient-search', clinicId, query],
    queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients/search`, { method: 'POST', body: JSON.stringify({ query }) }),
    enabled: open && searching,
    retry: false,
    staleTime: 30_000,
  });

  const go = (href: string) => { onOpenChange(false); router.push(href); };
  const matches = (label: string) => !text.trim() || label.toLowerCase().includes(text.trim().toLowerCase());
  const actions = [
    canBook && { key: 'book', label: 'New booking', icon: CalendarPlus, run: () => go(`/c/${clinicId}/schedule?new=1`), hint: 'N' },
    canTestCall && { key: 'test', label: 'Start a test call', icon: Mic, run: () => go(`/c/${clinicId}/test-call`) },
    { key: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, run: () => { onOpenChange(false); onShortcuts(); }, hint: '?' },
  ].filter(Boolean) as { key: string; label: string; icon: typeof Mic; run: () => void; hint?: string }[];
  const themes = [
    { key: 'system', label: 'Theme: match the system', icon: Monitor },
    { key: 'light', label: 'Theme: light', icon: Sun },
    { key: 'dark', label: 'Theme: dark', icon: Moon },
  ] as const;

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-overlay animate-fade-in" />
        <D.Content className="fixed top-[12vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-lg animate-rise-in" aria-describedby={undefined}>
          <D.Title className="sr-only">Search and jump</D.Title>
          <Command shouldFilter={false} label="Search and jump" loop>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-text-muted" aria-hidden />
              <Command.Input value={text} onValueChange={setText} autoFocus placeholder={canSearchPatients ? 'Go to a page, find a patient, or do something' : 'Go to a page, or do something'}
                className="h-12 flex-1 bg-transparent text-md text-text outline-none placeholder:text-text-muted" />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-text-muted">
                {searching && patients.isFetching ? 'Searching…' : 'Nothing matches. Try a name, a date of birth or a page.'}
              </Command.Empty>
              {searching && (patients.data?.patients.length ?? 0) > 0 && (
                <Command.Group heading="Patients" className={group}>
                  {patients.data!.patients.slice(0, 8).map((p) => (
                    <Command.Item key={p.id} value={`patient-${p.id}`} onSelect={() => go(`/c/${clinicId}/patients/${p.id}`)} className={item}>
                      <User aria-hidden /><span className="flex-1">{p.name}</span><span className="text-sm text-text-muted">Born {dob(p.dob)}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {pages.some((p) => matches(p.label)) && (
                <Command.Group heading="Go to" className={group}>
                  {pages.filter((p) => matches(p.label)).map((p) => (
                    <Command.Item key={p.href || 'today'} value={`page-${p.href}`} onSelect={() => go(p.href ? `/c/${clinicId}/${p.href}` : `/c/${clinicId}`)} className={item}>
                      <p.icon aria-hidden /><span className="flex-1">{p.label}</span>{p.shortcut && <span className="flex gap-1"><Kbd>G</Kbd><Kbd>{p.shortcut.toUpperCase()}</Kbd></span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {actions.some((a) => matches(a.label)) && (
                <Command.Group heading="Do" className={group}>
                  {actions.filter((a) => matches(a.label)).map((a) => (
                    <Command.Item key={a.key} value={`action-${a.key}`} onSelect={a.run} className={item}>
                      <a.icon aria-hidden /><span className="flex-1">{a.label}</span>{a.hint && <Kbd>{a.hint}</Kbd>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {themes.some((t) => matches(t.label)) && (
                <Command.Group heading="Appearance" className={group}>
                  {themes.filter((t) => matches(t.label)).map((t) => (
                    <Command.Item key={t.key} value={`theme-${t.key}`} onSelect={() => { theme.set(t.key); onOpenChange(false); }} className={item}>
                      <t.icon aria-hidden /><span className="flex-1">{t.label}</span>{theme.choice === t.key && <span className="text-sm text-text-muted">Current</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
