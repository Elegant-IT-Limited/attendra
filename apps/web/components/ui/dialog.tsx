// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A panel on the right (side="right") or a centred dialog. Both trap focus, close
 * with Escape or the close button, and give focus back to what opened them.
 */
export function Panel({ open, onOpenChange, title, description, side = 'center', children, footer, className }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  side?: 'right' | 'center';
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-overlay animate-fade-in" />
        <D.Content
          className={cn('fixed z-50 flex flex-col bg-surface-raised text-text shadow-lg focus-visible:outline-none',
            side === 'right'
              ? 'inset-y-0 right-0 w-full max-w-md border-l border-border animate-slide-in'
              : 'left-1/2 top-1/2 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border animate-rise-in',
            className)}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="space-y-1">
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description ? <D.Description className="text-sm text-text-muted">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="focus-ring rounded-md p-1 text-text-muted hover:bg-surface-sunken hover:text-text max-md:p-2.5" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
