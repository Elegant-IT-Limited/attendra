// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { Trash2 } from 'lucide-react';
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** One settings card. With an `id` it is a place the page's own menu can jump to. */
export function Section({ id, title, description, children, action }: { id?: string; title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-6">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="min-w-0 space-y-1"><CardTitle>{title}</CardTitle>{description && <CardDescription className="max-w-2xl">{description}</CardDescription>}</div>
        {action && <div className="shrink-0">{action}</div>}
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

/**
 * A setting's label, its control and a hint, stacked. The control gets an id and is
 * tied to the label and the hint, so every field in a list of rows (visit types,
 * routing, offers) has a name a screen reader can say.
 */
export function Field({ label, hint, htmlFor, children, className }: { label: string; hint?: string; htmlFor?: string; children: ReactNode; className?: string }) {
  const auto = useId();
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<{ id?: string; 'aria-describedby'?: string }>) : null;
  const id = htmlFor ?? only?.props.id ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const control = only ? cloneElement(only, { id, 'aria-describedby': hintId }) : children;
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      {control}
      {hint && <p id={hintId} className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

/**
 * One item in a list a clinic builds (a visit type, a rule, an offer): its fields, a
 * way to remove it, and, in a list with an order, the handle that moves it (Sortable).
 */
export function Item({ id, children, onRemove, removeLabel, className, handle }: { id?: string; children: ReactNode; onRemove: () => void; removeLabel: string; className?: string; handle?: ReactNode }) {
  return (
    <div id={id} className={cn('relative rounded-lg border border-border bg-surface-sunken/40 p-4 pr-14', handle && 'pl-12', className)}>
      {handle && <div className="absolute left-2 top-3">{handle}</div>}
      {children}
      <Button type="button" size="icon" variant="ghost" className="absolute right-2 top-2 text-text-muted hover:text-danger" aria-label={removeLabel} onClick={onRemove}><Trash2 /></Button>
    </div>
  );
}

/** What a list says while it is empty. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-text-muted">{children}</p>;
}
