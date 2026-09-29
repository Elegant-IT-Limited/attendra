// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { CalendarDays, Check } from 'lucide-react';
import { Checkbox as C, RadioGroup as R, Switch as S } from 'radix-ui';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A checkbox with its label beside it, and an optional line of explanation under the label. */
export function Checkbox({ id, label, hint, checked, onCheckedChange, disabled }: { id: string; label: ReactNode; hint?: ReactNode; checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <C.Root id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} disabled={disabled}
        className="focus-ring mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border border-border-strong bg-surface transition-colors data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-on-primary disabled:opacity-50 max-md:size-5"
        aria-describedby={hint ? `${id}-hint` : undefined}>
        <C.Indicator><Check className="size-3" strokeWidth={3} /></C.Indicator>
      </C.Root>
      <div className="text-base">
        <label htmlFor={id} className="font-medium">{label}</label>
        {hint && <p id={`${id}-hint`} className="text-sm text-text-muted">{hint}</p>}
      </div>
    </div>
  );
}

/** An on or off setting that takes effect when saved or at once, with its label. */
export function Switch({ id, label, hint, checked, onCheckedChange, disabled }: { id: string; label: ReactNode; hint?: ReactNode; checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-base">
        <label htmlFor={id} className="font-medium">{label}</label>
        {hint && <p id={`${id}-hint`} className="text-sm text-text-muted">{hint}</p>}
      </div>
      <S.Root id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined}
        className="focus-ring relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-border-strong transition-colors data-[state=checked]:bg-primary disabled:opacity-50">
        <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-surface shadow-xs transition-transform data-[state=checked]:translate-x-[18px]" />
      </S.Root>
    </div>
  );
}

/** One choice from a few, all visible. */
export function RadioGroup<T extends string>({ label, value, onValueChange, options, disabled }: {
  label: string; value: T; onValueChange: (v: T) => void; options: { value: T; label: ReactNode; hint?: ReactNode }[]; disabled?: boolean;
}) {
  return (
    <R.Root aria-label={label} value={value} onValueChange={(v) => onValueChange(v as T)} disabled={disabled} className="space-y-2">
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-start gap-3 text-base">
          <R.Item value={o.value} className="focus-ring mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface data-[state=checked]:border-primary max-md:size-5">
            <R.Indicator className="size-2 rounded-full bg-primary" />
          </R.Item>
          <span><span className="font-medium">{o.label}</span>{o.hint && <span className="block text-sm text-text-muted">{o.hint}</span>}</span>
        </label>
      ))}
    </R.Root>
  );
}

/**
 * A date. The browser's own picker, which knows the person's locale, keyboard and
 * screen reader better than a hand-built calendar would, in the kit's field style.
 */
export function DatePicker({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <span className={cn('relative inline-flex h-9 w-40 max-md:h-11', className)}>
      <input type="date" {...props}
        className="focus-ring h-full w-full rounded-md border border-border-strong bg-surface pr-8 pl-3 text-base text-text shadow-xs [color-scheme:inherit] disabled:opacity-50 [&::-webkit-calendar-picker-indicator]:opacity-0" />
      <CalendarDays className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
    </span>
  );
}
