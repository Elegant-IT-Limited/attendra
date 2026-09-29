// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { TaskCount } from '@attendra/api/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, House, ListChecks, LogOut, Mic, Phone, PhoneCall, Settings, ShieldCheck, UserCog, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useCallback, useEffect } from 'react';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { api, useClinic } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

// The menu in the groups a front desk thinks in. A group with nothing the role may open is not shown.
const NAV: { group: string | null; items: { href: string; label: string; icon: typeof Phone; permission: string }[] }[] = [
  { group: null, items: [{ href: '', label: 'Today', icon: House, permission: 'calls:list' }] },
  {
    group: 'Front desk',
    items: [
      { href: 'schedule', label: 'Schedule', icon: CalendarDays, permission: 'schedule:read' },
      { href: 'patients', label: 'Patients', icon: Users, permission: 'patients:read' },
      { href: 'requests', label: 'Requests', icon: ListChecks, permission: 'tasks:read' },
      { href: 'calls', label: 'Calls', icon: Phone, permission: 'calls:list' },
    ],
  },
  {
    group: 'Assistant',
    items: [
      { href: 'test-call', label: 'Test call', icon: Mic, permission: 'calls:test' },
      { href: 'settings', label: 'Settings', icon: Settings, permission: 'settings:read' },
    ],
  },
  {
    group: 'Admin',
    items: [
      { href: 'team', label: 'Team', icon: UserCog, permission: 'members:manage' },
      { href: 'audit', label: 'Audit log', icon: ShieldCheck, permission: 'audit:read' },
    ],
  },
];

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Practice manager', staff: 'Front desk', viewer: 'Viewer' };

// A workstation left open at the front desk signs itself out.
const IDLE_MS = 15 * 60_000;

export function Shell({ clinicId, children }: { clinicId: string; children: ReactNode }) {
  const pathname = usePathname();
  const queries = useQueryClient();
  const { data: me, clinic, can, isPending } = useClinic(clinicId);
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

  if (isPending) return <div className="p-8"><Skeleton className="h-8 w-64" /></div>;
  if (!clinic) return <Empty title="Clinic not found">You are not a member of this clinic, or it does not exist.</Empty>;

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[232px_1fr]">
      <aside className="flex flex-col border-b border-border bg-card md:min-h-dvh md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-5 pt-5 pb-3">
          <PhoneCall className="size-5 text-primary" />
          <span className="font-semibold tracking-tight">Attendra</span>
        </div>
        <div className="px-5 pb-4">
          <p className="truncate text-sm font-medium">{clinic.name}</p>
          <p className="text-xs text-muted-foreground">{clinic.timezone.replace('_', ' ')}</p>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:gap-4 md:overflow-visible">
          {NAV.map((g) => ({ ...g, items: g.items.filter((n) => can(n.permission) && (n.href !== 'test-call' || me?.testCalls)) })).filter((g) => g.items.length).map((g) => (
            <div key={g.group ?? 'home'} className="flex gap-1 md:flex-col" role="group" aria-label={g.group ?? 'Home'}>
              {g.group && <p className="hidden px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:block">{g.group}</p>}
              {g.items.map((n) => {
                const active = n.href ? pathname.startsWith(`/c/${clinicId}/${n.href}`) : pathname === `/c/${clinicId}`;
                const count = n.href === 'requests' ? openTasks.data?.open : undefined;
                return (
                  <Link key={n.href || 'today'} href={n.href ? `/c/${clinicId}/${n.href}` : `/c/${clinicId}`} aria-current={active ? 'page' : undefined}
                    className={cn('flex items-center gap-2.5 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                    <n.icon className="size-4" aria-hidden />
                    <span className="flex-1">{n.label}</span>
                    {!!count && <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground" aria-label={`${count} open`}>{count}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="mt-auto hidden border-t border-border px-5 py-4 md:block">
          <p className="truncate text-sm font-medium">{me?.user.name}</p>
          <p className="text-xs text-muted-foreground">{ROLE_LABEL[clinic.role]}</p>
          <button onClick={() => void signOut()} className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </aside>
      <div className="min-w-0">
        {me?.demoMode && (
          <div className="border-b border-border bg-warn-soft px-6 py-2 text-xs">
            Demo mode. Every patient and call here is synthetic, and two-step sign-in is switched off.
          </div>
        )}
        <main className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
