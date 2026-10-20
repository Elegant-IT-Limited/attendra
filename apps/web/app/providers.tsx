// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { TooltipProvider } from '@/components/ui/overlay';
import { ToastProvider } from '@/components/ui/toast';
import { ApiFailure, redirectFor } from '@/lib/api';
import { safeNext, signedOutOnPurpose } from '@/lib/next';

// A signed-out or not-yet-enrolled person is sent to the right page from any screen. A
// session that ended mid-work says so on the sign-in page, and comes back to the same page.
function follow(error: unknown) {
  const to = redirectFor(error);
  if (!to || window.location.pathname === to) return;
  if (to === '/sign-in' && signedOutOnPurpose()) window.location.href = to;
  else if (to === '/sign-in') {
    const here = window.location.pathname + window.location.search;
    window.location.href = `/sign-in?expired=1${safeNext(here) ? `&next=${encodeURIComponent(here)}` : ''}`;
  } else window.location.href = to;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    queryCache: new QueryCache({ onError: follow }),
    mutationCache: new MutationCache({ onError: follow }),
    defaultOptions: {
      queries: {
        retry: (count, error) => !(error instanceof ApiFailure && error.status < 500) && count < 2,
        refetchOnWindowFocus: true,
      },
    },
  }));
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={300}>
        <ToastProvider>{children}</ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
