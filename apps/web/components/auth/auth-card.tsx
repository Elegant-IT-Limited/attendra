// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';

/**
 * The centred card every sign-in step uses. With `pending`, it is laid out but not
 * shown, so content that arrives a moment later (the demo logins) does not move the
 * form under someone's cursor.
 */
export function AuthCard({ title, subtitle, children, pending = false, footer }: { title: string; subtitle?: string; children: ReactNode; pending?: boolean; footer?: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <div className={pending ? 'invisible w-full max-w-sm space-y-6' : 'w-full max-w-sm space-y-6'} aria-busy={pending || undefined}>
        <div className="flex items-center gap-2">
          <BrandMark className="size-7" />
          <span className="text-md font-semibold tracking-tight text-text">Attendra</span>
        </div>
        <div className="space-y-5 rounded-lg border border-border bg-surface p-6 shadow-xs">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="text-base text-text-muted">{subtitle}</p>}
          </div>
          {children}
        </div>
        {footer && <p className="text-center text-sm text-text-muted">{footer}</p>}
        <p className="text-center text-xs text-text-muted">Attendra keeps patient data encrypted and every view in an audit log.</p>
      </div>
    </main>
  );
}
