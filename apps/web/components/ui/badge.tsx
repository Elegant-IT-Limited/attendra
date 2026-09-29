// SPDX-License-Identifier: AGPL-3.0-only
import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badge = cva('inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3', {
  variants: {
    tone: {
      neutral: 'bg-surface-sunken text-text-muted',
      ok: 'bg-success-soft text-text',
      warn: 'bg-warning-soft text-text',
      danger: 'bg-danger-soft text-danger',
      accent: 'bg-primary-soft text-text',
      info: 'bg-info-soft text-text',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export type BadgeTone = NonNullable<VariantProps<typeof badge>['tone']>;

/** A short label on a row or a title: an outcome, a type, a count. */
export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

const DOT: Record<BadgeTone, string> = { neutral: 'bg-text-muted', ok: 'bg-success', warn: 'bg-warning', danger: 'bg-danger', accent: 'bg-primary', info: 'bg-info' };

/** A state with a coloured dot: Open, Live, Unclaimed. `live` makes the dot pulse. */
export function StatusPill({ tone = 'neutral', live, children, className }: { tone?: BadgeTone; live?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-xs font-medium', className)}>
      <span className={cn('size-1.5 rounded-full', DOT[tone], live && 'animate-live')} aria-hidden />
      {children}
    </span>
  );
}
