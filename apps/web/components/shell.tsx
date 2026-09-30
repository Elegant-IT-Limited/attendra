// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TaskCount } from '@attendra/api/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, LogOut, Monitor, Moon, MoreHorizontal, PhoneCall, Search, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { DropdownMenu as M } from 'radix-ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { EmergencyAlerts } from '@/components/calls/live-now';
import { CommandPalette } from '@/components/command-palette';
import { Avatar, Kbd } from '@/components/ui/bits';
import { Panel } from '@/components/ui/dialog';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { Tooltip } from '@/components/ui/overlay';
import { api, useClinic } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { useEmergencyAlerts } from '@/lib/live';
import { NAV, type NavItem, PHONE_BAR } from '@/lib/nav';
import { SHORTCUTS, useShortcuts } from '@/lib/shortcuts';
import { type ThemeChoice, useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Practice manager', staff: 'Front desk', viewer: 'Viewer' };

// A workstation left open at the front desk signs itself out.
const IDLE_MS = 15 * 60_000;

/**
 * The frame around every clinic page. A full sidebar from 1280 px, icons only from
 * 1024 px down to a tablet, and on a phone a bottom bar with Today, Schedule,
 * Requests and More. The command palette and the keyboard shortcuts live here, so
 * they work on every page.
 */
export function Shell({ clinicId, children }: { clinicId: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queries = useQueryClient();
  const { data: me, clinic, can, isPending } = useClinic(clinicId);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [more, setMore] = useState(false);
  // the badge needs a number only: no patient data, no audit row per poll
  const openTasks = useQuery({
    queryKey: ['tasks', clinicId, 'count'],
    queryFn: () => api<TaskCount>(`/clinics/${clinicId}/tasks/count`),
    enabled: can('tasks:read'),
    refetchInterval: 30_000,
  });

  // Drops every cached call, transcript and task before leaving, and reloads, so the
  // next person at this screen starts from nothing.
  const signOut = useCallback(async (reason?: 'idle') => {
    await authClient.signOut().catch(() => {});
    queries.clear();
    window.location.assign(reason ? `/sign-in?${reason}=1` : '/sign-in');
  }, [queries]);

  useEffect(() => {
    let timer = setTimeout(() => void signOut('idle'), IDLE_MS);
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => void signOut('idle'), IDLE_MS); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    return () => { clearTimeout(timer); for (const e of events) window.removeEventListener(e, reset); };
  }, [signOut]);

  const pages = NAV.flatMap((g) => g.items).filter((n) => can(n.permission) && (n.href !== 'test-call' || me?.testCalls));
  const hrefOf = (n: NavItem) => (n.href ? `/c/${clinicId}/${n.href}` : `/c/${clinicId}`);
  useShortcuts({
    palette: () => setPalette(true),
    go: (k) => { const p = pages.find((x) => x.shortcut === k); if (p) router.push(hrefOf(p)); },
    newBooking: () => { if (can('schedule:write')) router.push(`/c/${clinicId}/schedule?new=1`); },
    help: () => setHelp(true),
  });

  if (isPending) return <div className="p-8"><Skeleton className="h-8 w-64" /></div>;
  if (!clinic) return <Empty title="Clinic not found" action={<Link className="text-primary hover:underline" href="/">Go to your clinics</Link>}>You are not a member of this clinic, or it does not exist.</Empty>;

  const active = (n: NavItem) => (n.href ? pathname.startsWith(`/c/${clinicId}/${n.href}`) : pathname === `/c/${clinicId}`);
  const count = (n: NavItem) => (n.href === 'requests' ? openTasks.data?.open : undefined);
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((n) => pages.includes(n)) })).filter((g) => g.items.length);
  const phoneBar = pages.filter((p) => PHONE_BAR.includes(p.href));
  const user = { name: me?.user.name ?? '', role: ROLE_LABEL[clinic.role] ?? clinic.role };

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[64px_1fr] xl:grid-cols-[240px_1fr]">
      <a href="#main" className="focus-ring sr-only z-50 rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">Skip to content</a>

      {/* tablet and desktop: the sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface md:flex">
        <div className="flex items-center gap-2 px-5 pt-5 pb-3 max-xl:justify-center max-xl:px-0">
          <PhoneCall className="size-5 text-primary" aria-hidden />
          <span className="font-semibold tracking-tight max-xl:sr-only">Attendra</span>
        </div>
        <div className="px-5 pb-3 max-xl:hidden">
          <p className="truncate text-base font-medium">{clinic.name}</p>
          <p className="text-xs text-text-muted">{clinic.timezone.replaceAll('_', ' ')}</p>
        </div>
        <div className="px-3 pb-3 max-xl:px-2">
          <button type="button" onClick={() => setPalette(true)} aria-label="Search and jump"
            className="focus-ring flex h-9 w-full items-center gap-2 rounded-md border border-border-strong bg-surface-sunken px-2.5 text-sm text-text-muted hover:text-text max-xl:justify-center max-xl:px-0">
            <Search className="size-4" aria-hidden /><span className="flex-1 text-left max-xl:hidden">Search</span><span className="flex gap-0.5 max-xl:hidden"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
          </button>
        </div>
        <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto px-3 pb-3 max-xl:px-2">
          {groups.map((g) => (
            <div key={g.group ?? 'home'} role="group" aria-label={g.group ?? 'Home'} className="space-y-0.5">
              {g.group && <p className="px-3 pb-1 text-xs font-medium text-text-muted max-xl:sr-only">{g.group}</p>}
              {g.items.map((n) => (
                <NavLink key={n.href || 'today'} item={n} href={hrefOf(n)} active={active(n)} count={count(n)} />
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-border p-3 max-xl:px-2">
          <UserMenu user={user} onSignOut={() => void signOut()} onShortcuts={() => setHelp(true)} />
        </div>
      </aside>

      {/* phone: a top bar */}
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-surface px-4 py-2 md:hidden">
        <PhoneCall className="size-5 text-primary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-base font-medium">{clinic.name}</p>
        <button type="button" aria-label="Search and jump" onClick={() => setPalette(true)} className="focus-ring flex size-11 items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken"><Search className="size-5" /></button>
        <UserMenu compact user={user} onSignOut={() => void signOut()} onShortcuts={() => setHelp(true)} />
      </header>

      <div className="min-w-0 pb-20 md:pb-0">
        {me?.demoMode && (
          <div className="border-b border-warning/30 bg-warning-soft px-6 py-2 text-sm" role="note">
            Demo mode. Every patient and call here is synthetic, and two-step sign-in is switched off.
          </div>
        )}
        <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6 outline-none md:px-8 md:py-8">{children}</main>
      </div>

      {/* phone: the bottom bar */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {phoneBar.map((n) => (
          <Link key={n.href || 'today'} href={hrefOf(n)} aria-current={active(n) ? 'page' : undefined}
            className={cn('focus-ring relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs', active(n) ? 'font-medium text-primary' : 'text-text-muted')}>
            <n.icon className="size-5" aria-hidden />{n.label}
            {!!count(n) && <span className="absolute top-1.5 right-[calc(50%-18px)] rounded-full bg-primary px-1 text-xs leading-4 text-on-primary">{count(n)}</span>}
          </Link>
        ))}
        <button type="button" onClick={() => setMore(true)} className="focus-ring flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs text-text-muted">
          <MoreHorizontal className="size-5" aria-hidden />More
        </button>
      </nav>
      <Panel side="right" open={more} onOpenChange={setMore} title="More">
        <div className="space-y-1">
          {pages.filter((p) => !PHONE_BAR.includes(p.href)).map((n) => (
            <div key={n.href} onClick={() => setMore(false)}><NavLink item={n} href={hrefOf(n)} active={active(n)} count={count(n)} expanded /></div>
          ))}
        </div>
      </Panel>

      <EmergencyAlerts clinicId={clinicId} />
      <CommandPalette clinicId={clinicId} open={palette} onOpenChange={setPalette} pages={pages}
        canSearchPatients={can('patients:read')} canBook={can('schedule:write')} canTestCall={can('calls:test') && !!me?.testCalls} onShortcuts={() => setHelp(true)} />
      <Panel open={help} onOpenChange={setHelp} title="Keyboard shortcuts" description="Letters work when you are not typing in a field.">
        <ul className="space-y-2">
          {SHORTCUTS.filter((s) => (!s.page || pages.some((p) => p.shortcut === s.page)) && (!s.permission || can(s.permission))).map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-4 text-base">
              <span>{s.label}</span><span className="flex gap-1">{s.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function NavLink({ item: n, href, active, count, expanded }: { item: NavItem; href: string; active: boolean; count?: number; expanded?: boolean }) {
  const link = (
    <Link href={href} aria-current={active ? 'page' : undefined}
      className={cn('focus-ring relative flex items-center gap-2.5 rounded-md px-3 py-2 text-base whitespace-nowrap transition-colors max-md:min-h-11',
        !expanded && 'max-xl:justify-center max-xl:px-0',
        active ? 'bg-primary-soft font-medium text-text' : 'text-text-muted hover:bg-surface-sunken hover:text-text')}>
      <n.icon className="size-4 shrink-0" aria-hidden />
      <span className={cn('flex-1', !expanded && 'max-xl:sr-only')}>{n.label}</span>
      {!!count && <span className={cn('rounded-full bg-primary px-1.5 text-xs font-medium text-on-primary', !expanded && 'max-xl:absolute max-xl:top-0.5 max-xl:right-0.5 max-xl:px-1')} aria-label={`${count} open`}>{count}</span>}
    </Link>
  );
  return expanded ? link : <Tooltip content={n.label}>{link}</Tooltip>;
}

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'Match the system', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

function UserMenu({ user, onSignOut, onShortcuts, compact }: { user: { name: string; role: string }; onSignOut: () => void; onShortcuts: () => void; compact?: boolean }) {
  const theme = useTheme();
  const [alerts, setAlerts] = useEmergencyAlerts();
  return (
    <M.Root>
      <M.Trigger aria-label={`${user.name}, ${user.role}: account and theme`}
        className={cn('focus-ring flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-surface-sunken', compact ? 'size-11 justify-center p-0' : 'max-xl:justify-center')}>
        <Avatar name={user.name || '?'} />
        {!compact && <span className="min-w-0 flex-1 max-xl:hidden"><span className="block truncate text-base font-medium">{user.name}</span><span className="block text-xs text-text-muted">{user.role}</span></span>}
      </M.Trigger>
      <M.Portal>
        <M.Content side={compact ? 'bottom' : 'top'} align={compact ? 'end' : 'start'} sideOffset={6} className="z-50 min-w-56 rounded-md border border-border bg-surface-raised p-1 text-text shadow-lg animate-rise-in">
          <M.Label className="px-2.5 py-1.5 text-xs text-text-muted">Theme</M.Label>
          <M.RadioGroup value={theme.choice} onValueChange={(v) => theme.set(v as ThemeChoice)}>
            {THEMES.map((t) => (
              <M.RadioItem key={t.value} value={t.value} className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-base outline-none data-[highlighted]:bg-surface-sunken data-[state=checked]:font-medium max-md:min-h-11">
                <t.icon className="size-4 text-text-muted" aria-hidden />{t.label}
                <M.ItemIndicator className="ml-auto size-1.5 rounded-full bg-primary" />
              </M.RadioItem>
            ))}
          </M.RadioGroup>
          <M.Separator className="my-1 h-px bg-border" />
          <M.CheckboxItem checked={alerts} onCheckedChange={(v) => setAlerts(v === true)} onSelect={(e) => e.preventDefault()}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-base outline-none data-[highlighted]:bg-surface-sunken max-md:min-h-11">
            <BellRing className="size-4 text-text-muted" aria-hidden />Alert me to emergencies
            <M.ItemIndicator className="ml-auto text-xs text-primary">On</M.ItemIndicator>
          </M.CheckboxItem>
          <M.Item onSelect={onShortcuts} className="flex cursor-pointer items-center rounded-sm px-2.5 py-1.5 text-base outline-none data-[highlighted]:bg-surface-sunken max-md:min-h-11">Keyboard shortcuts<span className="ml-auto"><Kbd>?</Kbd></span></M.Item>
          <M.Item onSelect={onSignOut} className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-base outline-none data-[highlighted]:bg-surface-sunken max-md:min-h-11"><LogOut className="size-4 text-text-muted" aria-hidden />Sign out</M.Item>
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

/** Every page's header: a title, one line on what the page is for, and its main action on the right. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="max-w-3xl text-base text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
