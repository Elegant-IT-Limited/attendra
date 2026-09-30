// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function Section({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1"><CardTitle>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</div>
        {action}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

/**
 * A setting's label, its control and a hint. The control gets an id and is tied to
 * the label and the hint, so every field in a list of rows (visit types, providers,
 * routing) has a name a screen reader can say.
 */
export function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  const auto = useId();
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<{ id?: string; 'aria-describedby'?: string }>) : null;
  const id = htmlFor ?? only?.props.id ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const control = only ? cloneElement(only, { id, 'aria-describedby': hintId }) : children;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {control}
      {hint && <p id={hintId} className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
