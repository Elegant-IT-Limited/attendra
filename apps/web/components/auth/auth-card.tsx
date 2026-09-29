// SPDX-License-Identifier: AGPL-3.0-only
import { PhoneCall } from 'lucide-react';
import type { ReactNode } from 'react';

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2 text-primary">
          <PhoneCall className="size-5" />
          <span className="text-lg font-semibold tracking-tight text-foreground">Attendra</span>
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}
