// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useClinic } from '@/lib/api';
import { cn } from '@/lib/utils';

/** The parts of Settings: what the assistant is and does, what it knows, and where its events go. */
export const SETTINGS_PAGES: { href: string; label: string; permission?: string }[] = [
  { href: '', label: 'General' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/integrations', label: 'Integrations', permission: 'integrations:manage' },
];

export function SettingsNav({ clinicId }: { clinicId: string }) {
  const pathname = usePathname();
  const { can } = useClinic(clinicId);
  const base = `/c/${clinicId}/settings`;
  return (
    <nav aria-label="Settings" className="mb-6 flex gap-1 border-b border-border">
      {SETTINGS_PAGES.filter((p) => !p.permission || can(p.permission)).map((p) => {
        const href = `${base}${p.href}`;
        const active = p.href ? pathname.startsWith(href) : pathname === base;
        return (
          <Link key={p.href} href={href} aria-current={active ? 'page' : undefined}
            className={cn('focus-ring -mb-px border-b-2 px-3 py-2 text-base font-medium', active ? 'border-primary text-text' : 'border-transparent text-text-muted hover:text-text')}>
            {p.label}
          </Link>
        );
      })}
    </nav>
  );
}
