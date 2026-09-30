// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { DropdownMenu as M, Popover as P, Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const surface = 'z-50 rounded-md border border-border bg-surface-raised text-text shadow-lg animate-rise-in';

/** Extra controls or detail next to what opened it. Escape closes it and focus goes back. */
export function Popover({ trigger, children, align = 'start', className }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'center' | 'end'; className?: string }) {
  return (
    <P.Root>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal><P.Content align={align} sideOffset={6} className={cn(surface, 'w-72 p-4', className)}>{children}</P.Content></P.Portal>
    </P.Root>
  );
}

/** A short list of actions on one thing. Arrow keys move, Enter chooses, Escape closes. */
export function Menu({ trigger, items, align = 'end' }: { trigger: ReactNode; align?: 'start' | 'end'; items: ({ label: string; onSelect: () => void; danger?: boolean; disabled?: boolean } | 'separator')[] }) {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align={align} sideOffset={6} className={cn(surface, 'min-w-44 p-1')}>
          {items.map((it, i) => it === 'separator' ? <M.Separator key={i} className="my-1 h-px bg-border" /> : (
            <M.Item key={it.label} disabled={it.disabled} onSelect={it.onSelect}
              className={cn('flex cursor-pointer items-center rounded-sm px-2.5 py-1.5 text-base outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-sunken max-md:min-h-11', it.danger && 'text-danger')}>
              {it.label}
            </M.Item>
          ))}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

/** A few words about a control that has no visible label, or the exact time behind "12 minutes ago". */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <T.Root delayDuration={300}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content sideOffset={6} className="z-50 max-w-64 rounded-sm bg-text px-2 py-1 text-xs text-surface shadow-lg animate-fade-in">{content}</T.Content>
      </T.Portal>
    </T.Root>
  );
}
export const TooltipProvider = T.Provider;
