// SPDX-License-Identifier: AGPL-3.0-only
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A message inside a page: what happened, and what to do next. */
export function Alert({ tone = 'info', title, children, className }: { tone?: 'info' | 'danger' | 'warn' | 'ok'; title?: string; children?: ReactNode; className?: string }) {
  const Icon = tone === 'info' ? Info : tone === 'ok' ? CheckCircle2 : AlertTriangle;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-md border px-4 py-3 text-base',
      tone === 'danger' && 'border-danger/30 bg-danger-soft', tone === 'warn' && 'border-warning/30 bg-warning-soft',
      tone === 'info' && 'border-border bg-info-soft', tone === 'ok' && 'border-success/30 bg-success-soft', className)}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'danger' && 'text-danger', tone === 'warn' && 'text-warning', tone === 'ok' && 'text-success', tone === 'info' && 'text-info')} aria-hidden />
      <div className="space-y-1">{title && <p className="font-medium">{title}</p>}{children}</div>
    </div>
  );
}

/** The shape of what is loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-sunken', className)} aria-hidden />;
}

/** Nothing here yet: say what will appear and why, and offer the one next step. */
export function Empty({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-surface-sunken text-text-muted [&_svg]:size-5">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-sm text-sm text-text-muted">{children}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
export { Empty as EmptyState };
