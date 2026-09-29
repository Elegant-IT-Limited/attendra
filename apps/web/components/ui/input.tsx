// SPDX-License-Identifier: AGPL-3.0-only
import { ChevronDown } from 'lucide-react';
import { type InputHTMLAttributes, type LabelHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useId } from 'react';
import { cn } from '@/lib/utils';

const field = 'focus-ring w-full rounded-md border border-border-strong bg-surface px-3 text-base text-text shadow-xs transition-colors placeholder:text-text-muted hover:border-text-muted/60 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger max-md:min-h-11';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, 'h-9', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, 'min-h-20 py-2 leading-relaxed', className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    // the wrapper takes the size (h-8 w-48 and so on), the select fills it
    <span className={cn('relative inline-flex h-9 w-full max-md:h-11', className)}>
      <select className={cn(field, 'h-full appearance-none pr-8')} {...props}>{children}</select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
    </span>
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium text-text', className)} {...props} />;
}

/**
 * A labelled control with an optional hint and an inline error. The control gets
 * its id, aria-describedby and aria-invalid from here, so a screen reader reads the
 * label, the hint and the error with it.
 */
export function Field({ label, hint, error, children, className, id: given }: {
  label: ReactNode; hint?: ReactNode; error?: ReactNode; className?: string; id?: string;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const auto = useId();
  const id = given ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-describedby': [hintId, errorId].filter(Boolean).join(' ') || undefined, 'aria-invalid': error ? true : undefined })}
      {hint && !error && <p id={hintId} className="text-xs text-text-muted">{hint}</p>}
      {error && <p id={errorId} className="text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}
