// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { CallList, PatientList, TaskList } from '@attendra/api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { CalendarPlus, Keyboard, ListChecks, Mic, Monitor, Moon, PawPrint, Phone, Search, Sun, User, Users } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ClinicTile } from '@/components/clinic-switcher';
import { Kbd } from '@/components/ui/bits';
import { Highlight } from '@/components/ui/highlight';
import { api, useClinic } from '@/lib/api';
import { usePets } from '@/lib/terms';
import { clinicTime, dob, OUTCOMES, phone, taskType } from '@/lib/format';
import type { NavItem } from '@/lib/nav';
import { useTheme } from '@/lib/theme';

const item = 'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-base text-text aria-selected:bg-surface-sunken data-[disabled=true]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-muted max-md:min-h-11';
const group = '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-text-muted';
const muted = 'truncate text-sm text-text-muted';
/** How many of each kind the palette shows: enough to pick from, few enough to scan. */
const SHOWN = 6;

/** Who a request is about, as the Requests page names it. */
const requestWho = (t: TaskList['tasks'][number], patientWord: string) => t.patientName ?? t.details.pet_name
  ?? ([t.details.first_name, t.details.last_name].filter(Boolean).join(' ') || t.details.name || (t.callId ? 'Caller not verified' : `No ${patientWord} linked`));

/**
 * Cmd+K or Ctrl+K: jump anywhere or to another clinic, find a pet or patient (by its name,
 * its owner's name, a phone number, a birthday or a request number), a request or a call,
 * start a booking or a test call, switch the theme. Each search is the same POST its page
 * makes, so it is audited the same way and what is typed stays out of the address bar; only
 * what the person may read is searched.
 */
export function CommandPalette({ clinicId, open, onOpenChange, pages, clinics = [], onClinic, canSearchPatients, canSearchCalls = false, canSearchRequests = false, canBook, canTestCall, onShortcuts }: {
  clinicId: string; open: boolean; onOpenChange: (o: boolean) => void; pages: NavItem[];
  /** The person's other clinics: one opens the same page there. */
  clinics?: { id: string; name: string; role: string }[]; onClinic?: (id: string) => void;
  canSearchPatients: boolean; canSearchCalls?: boolean; canSearchRequests?: boolean; canBook: boolean; canTestCall: boolean; onShortcuts: () => void;
}) {
  const pets = usePets(clinicId);
  const patientWord = pets ? 'pet' : 'patient';
  const { clinic } = useClinic(clinicId);
  const tz = clinic?.timezone ?? 'UTC';
  const router = useRouter();
  const theme = useTheme();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  useEffect(() => { if (!open) { setText(''); setQuery(''); } }, [open]);
  const typed = query.length >= 2;
  const searching = canSearchPatients && typed;
  const patients = useQuery({
    queryKey: ['patient-search', clinicId, query],
    queryFn: () => api<PatientList>(`/clinics/${clinicId}/patients/search`, { method: 'POST', body: JSON.stringify({ query }) }),
    enabled: open && searching,
    retry: false,
    staleTime: 30_000,
  });
  // open requests and done ones alike: a number is most often looked up for one already closed
  const requests = useQuery({
    queryKey: ['request-search', clinicId, query],
    queryFn: async () => {
      const find = (status: 'open' | 'done') => api<TaskList>(`/clinics/${clinicId}/tasks/search`, { method: 'POST', body: JSON.stringify({ q: query, status }) });
      const [opened, done] = await Promise.all([find('open'), find('done')]);
      return [...opened.tasks, ...done.tasks];
    },
    enabled: open && canSearchRequests && typed,
    retry: false,
    staleTime: 30_000,
  });
  const calls = useQuery({
    queryKey: ['call-search', clinicId, query],
    queryFn: () => api<CallList>(`/clinics/${clinicId}/calls/search`, { method: 'POST', body: JSON.stringify({ query }) }),
    enabled: open && canSearchCalls && typed,
    retry: false,
    staleTime: 30_000,
  });
  const found = patients.data?.patients ?? [];
  // a record found by its owner's name sits under Owners, next to the owner's other pets; everything else under Pets
  const byOwner = found.filter((p) => p.matchedOn === 'owner').sort((a, b) => (a.guardianName ?? '').localeCompare(b.guardianName ?? '') || a.name.localeCompare(b.name));
  const byRecord = found.filter((p) => p.matchedOn !== 'owner');
  const fetching = (searching && patients.isFetching) || (canSearchRequests && typed && requests.isFetching) || (canSearchCalls && typed && calls.isFetching);
  const canSearch = canSearchPatients || canSearchCalls || canSearchRequests;
  const searchable = [
    canSearchPatients && (pets ? 'a pet\'s or owner\'s name, a phone number or its last four digits, a birthday' : 'a patient\'s or parent\'s name, a phone number or its last four digits, a date of birth'),
    (canSearchPatients || canSearchRequests || canSearchCalls) && 'a request number like R-1042',
    canSearchCalls && 'a caller',
  ].filter(Boolean).join(', ');

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
  const PetIcon = pets ? PawPrint : User;

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-overlay animate-fade-in" />
        <D.Content className="fixed top-[12vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-lg animate-rise-in" aria-describedby={undefined}>
          <D.Title className="sr-only">Search and jump</D.Title>
          <Command shouldFilter={false} label="Search and jump" loop>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-text-muted" aria-hidden />
              <Command.Input value={text} onValueChange={setText} autoFocus placeholder={canSearchPatients ? `Go to a page, find a ${patientWord}, a request or a call, or do something` : canSearch ? 'Go to a page, find a request or a call, or do something' : 'Go to a page, or do something'}
                className="h-12 flex-1 bg-transparent text-md text-text outline-none placeholder:text-text-muted" />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-text-muted">
                {fetching ? 'Searching…' : canSearch ? `Nothing matches. Search by ${searchable}, or type a page.` : 'Nothing matches. Type a page or an action.'}
              </Command.Empty>
              {searching && byRecord.length > 0 && (
                <Command.Group heading={pages.find((p) => p.href === 'patients')?.label ?? 'Patients'} className={group}>
                  {byRecord.slice(0, SHOWN).map((p) => (
                    <Command.Item key={p.id} value={`patient-${p.id}`} onSelect={() => go(`/c/${clinicId}/patients/${p.id}`)} className={item}>
                      <PetIcon aria-hidden />
                      <span className="flex-1 truncate"><Highlight text={p.name} query={p.matchedOn === 'name' ? query : ''} /></span>
                      <span className={muted}>{p.matchedOn === 'phone' && p.phone ? <Highlight text={phone(p.phone)} query={query} /> : p.matchedOn === 'request' ? 'On that request' : `Born ${dob(p.dob)}`}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {searching && byOwner.length > 0 && (
                <Command.Group heading={pets ? 'Owners' : 'Parents and guardians'} className={group}>
                  {byOwner.slice(0, SHOWN).map((p) => (
                    <Command.Item key={p.id} value={`owner-${p.id}`} onSelect={() => go(`/c/${clinicId}/patients/${p.id}`)} className={item}>
                      <Users aria-hidden />
                      <span className="flex-1 truncate"><Highlight text={p.guardianName} query={query} /></span>
                      <span className={muted}>{p.name}{p.species ? `, ${p.species}` : ''}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {canSearchRequests && typed && (requests.data?.length ?? 0) > 0 && (
                <Command.Group heading="Requests" className={group}>
                  {requests.data!.slice(0, SHOWN).map((t) => (
                    <Command.Item key={t.id} value={`request-${t.id}`} onSelect={() => go(`/c/${clinicId}/requests?open=${t.id}${t.status === 'done' ? '&status=done' : ''}`)} className={item}>
                      <ListChecks aria-hidden />
                      <span className="flex-1 truncate">
                        <Highlight text={t.number === null ? 'Request' : `R-${t.number}`} query={query} /> · {taskType(t.type, patientWord)} · <Highlight text={requestWho(t, patientWord)} query={query} />
                      </span>
                      {t.status === 'done' && <span className={muted}>Done</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {canSearchCalls && typed && (calls.data?.calls.length ?? 0) > 0 && (
                <Command.Group heading="Calls" className={group}>
                  {calls.data!.calls.slice(0, SHOWN).map((c) => (
                    <Command.Item key={c.id} value={`call-${c.id}`} onSelect={() => go(`/c/${clinicId}/calls/${c.id}`)} className={item}>
                      <Phone aria-hidden />
                      <span className="flex-1 truncate">
                        {c.patientName ? <Highlight text={c.patientName} query={query} /> : c.callerNumber ? <Highlight text={phone(c.callerNumber)} query={query} /> : 'Unknown caller'}
                        {' · '}{clinicTime(c.startedAt, tz)}
                      </span>
                      <span className={muted}>{c.emergency ? 'Emergency' : OUTCOMES[c.outcome ?? '']?.label ?? 'Call'}</span>
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
              {onClinic && clinics.some((c) => matches(c.name)) && (
                <Command.Group heading="Clinics" className={group}>
                  {clinics.filter((c) => matches(c.name)).map((c) => (
                    <Command.Item key={c.id} value={`clinic-${c.id}`} onSelect={() => { onOpenChange(false); onClinic(c.id); }} className={item}>
                      <ClinicTile clinic={c} className="size-6" /><span className="flex-1">{c.name}</span><span className="text-sm text-text-muted">{c.role}</span>
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
