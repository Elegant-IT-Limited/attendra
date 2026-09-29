// SPDX-License-Identifier: AGPL-3.0-only
import { PhoneCall } from 'lucide-react';
import type { ReactNode } from 'react';

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2 text-primary">
          <PhoneCall className="size-5" aria-hidden />
          <span className="text-md font-semibold tracking-tight text-text">Attendra</span>
        </div>
        <div className="space-y-5 rounded-lg border border-border bg-surface p-6 shadow-xs">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="text-base text-text-muted">{subtitle}</p>}
          </div>
          {children}
        </div>
        <p className="text-center text-xs text-text-muted">Attendra keeps patient data encrypted and every view in an audit log.</p>
      </div>
    </main>
  );
}
