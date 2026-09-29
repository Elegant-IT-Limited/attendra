// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/** The parts of Settings: what the assistant is and does, and what it knows. */
export const SETTINGS_PAGES = [
  { href: '', label: 'General' },
  { href: '/knowledge', label: 'Knowledge' },
];

export function SettingsNav({ clinicId }: { clinicId: string }) {
  const pathname = usePathname();
  const base = `/c/${clinicId}/settings`;
  return (
    <nav aria-label="Settings" className="mb-6 flex gap-1 border-b border-border">
      {SETTINGS_PAGES.map((p) => {
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
