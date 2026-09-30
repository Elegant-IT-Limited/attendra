// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { Tabs as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Tabs for views of one thing (a patient's appointments, calls and requests).
 * Arrow keys move between them. `variant="pills"` is for filters above a list.
 */
export function Tabs<V extends string>({ value, onValueChange, tabs, label, variant = 'line', children, className }: {
  value: V; onValueChange: (v: V) => void; tabs: { value: V; label: ReactNode; count?: number | null }[]; label: string;
  variant?: 'line' | 'pills'; children?: ReactNode; className?: string;
}) {
  return (
    <T.Root value={value} onValueChange={(v) => onValueChange(v as V)} className={className}>
      <T.List aria-label={label} className={cn('flex gap-1 overflow-x-auto', variant === 'line' ? 'border-b border-border' : 'w-fit rounded-md border border-border-strong bg-surface p-0.5')}>
        {tabs.map((t) => (
          <T.Trigger key={t.value} value={t.value}
            className={cn('focus-ring inline-flex items-center gap-1.5 whitespace-nowrap text-base transition-colors max-md:min-h-11',
              variant === 'line'
                ? '-mb-px border-b-2 border-transparent px-3 py-2 text-text-muted hover:text-text data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-text'
                : 'rounded-sm px-3 py-1 text-text-muted hover:text-text data-[state=active]:bg-primary data-[state=active]:text-on-primary')}>
            {t.label}
            {!!t.count && <span className="rounded-full bg-surface-sunken px-1.5 text-xs text-text-muted">{t.count}</span>}
          </T.Trigger>
        ))}
      </T.List>
      {children}
    </T.Root>
  );
}
export const TabPanel = T.Content;
