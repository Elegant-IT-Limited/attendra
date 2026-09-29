// SPDX-License-Identifier: AGPL-3.0-only
import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badge = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3', {
  variants: {
    tone: {
      neutral: 'bg-muted text-muted-foreground',
      ok: 'bg-ok-soft text-foreground',
      warn: 'bg-warn-soft text-foreground',
      danger: 'bg-danger-soft text-danger',
      accent: 'bg-accent text-foreground',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
