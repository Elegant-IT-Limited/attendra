// SPDX-License-Identifier: AGPL-3.0-only
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const buttonStyles = cva(
  'focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-base font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-on-primary shadow-xs hover:bg-primary/90',
        outline: 'border border-border-strong bg-surface text-text shadow-xs hover:bg-surface-sunken',
        ghost: 'text-text hover:bg-surface-sunken',
        danger: 'bg-danger text-on-primary shadow-xs hover:bg-danger/90',
      },
      // phones get 44 px targets; desktop keeps the denser sizes
      size: { sm: 'h-8 px-3 text-sm max-md:h-11', md: 'h-9 px-4 max-md:h-11', lg: 'h-10 px-5', icon: 'size-9 max-md:size-11' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

/** The one button. `loading` keeps its width, shows a spinner and blocks a second click. */
export function Button({ className, variant, size, loading, disabled, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonStyles> & { loading?: boolean }) {
  return (
    <button className={cn(buttonStyles({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
