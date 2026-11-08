// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PageHeader } from '@/components/shell';
import { ScrollRegion } from '@/components/ui/scroll-region';
import { useClinic } from '@/lib/api';
import { cn } from '@/lib/utils';

/** The parts of Settings: what the assistant is and does, what it knows, and where its events go. */
export const SETTINGS_PAGES: { href: string; label: string; permission?: string }[] = [
  { href: '', label: 'General' },
  { href: '/emergencies', label: 'Emergencies' },
  { href: '/texting', label: 'Texting' },
  { href: '/fields', label: 'Fields and lists' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/integrations', label: 'Integrations', permission: 'integrations:manage' },
  { href: '/api-keys', label: 'API keys', permission: 'integrations:manage' },
];

export function SettingsNav({ clinicId }: { clinicId: string }) {
  const pathname = usePathname();
  const { can } = useClinic(clinicId);
  const base = `/c/${clinicId}/settings`;
  return (
    // one line on a phone too: it scrolls sideways instead of wrapping
    <ScrollRegion label="Settings pages" className="mb-6">
      <nav aria-label="Settings" className="flex w-max min-w-full gap-1 border-b border-border">
        {SETTINGS_PAGES.filter((p) => !p.permission || can(p.permission)).map((p) => {
          const href = `${base}${p.href}`;
          const active = p.href ? pathname.startsWith(href) : pathname === base;
          return (
            <Link key={p.href} href={href} aria-current={active ? 'page' : undefined}
              className={cn('focus-ring -mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-base font-medium', active ? 'border-primary text-text' : 'border-transparent text-text-muted hover:text-text')}>
              {p.label}
            </Link>
          );
        })}
      </nav>
    </ScrollRegion>
  );
}

/** The one line under "Settings" on every tab: the same words, so the header keeps its height and the tab row stays put. */
export const SETTINGS_DESCRIPTION = 'How the assistant answers, what it knows and can book, and where the clinic\'s events go. Changes apply to the next call.';

/**
 * Every Settings tab's header, loading and error states included: the title, the one description and the tab row. What a
 * tab is for goes under the row (SettingsIntro), so moving between tabs never moves the row (it did: each tab had its own
 * description, one to three lines long).
 */
export function SettingsHeader({ clinicId }: { clinicId: string }) {
  return (
    <>
      <PageHeader title="Settings" description={SETTINGS_DESCRIPTION} />
      <SettingsNav clinicId={clinicId} />
    </>
  );
}

/** What one Settings tab is for, under the tab row. */
export function SettingsIntro({ children }: { children: React.ReactNode }) {
  return <p className="mb-6 max-w-3xl text-sm text-text-muted" data-testid="settings-intro">{children}</p>;
}
