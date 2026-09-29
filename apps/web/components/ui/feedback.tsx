// SPDX-License-Identifier: AGPL-3.0-only
import { AlertTriangle, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Alert({ tone = 'info', title, children, className }: { tone?: 'info' | 'danger' | 'warn'; title?: string; children?: ReactNode; className?: string }) {
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm',
      tone === 'danger' && 'border-danger/30 bg-danger-soft', tone === 'warn' && 'border-border bg-warn-soft', tone === 'info' && 'border-border bg-accent', className)}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'danger' && 'text-danger')} />
      <div className="space-y-1">{title && <p className="font-medium">{title}</p>}{children}</div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-sm text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}
