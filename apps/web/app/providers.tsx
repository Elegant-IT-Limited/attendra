// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { TooltipProvider } from '@/components/ui/overlay';
import { ToastProvider } from '@/components/ui/toast';
import { ApiFailure, redirectFor } from '@/lib/api';

// A signed-out or not-yet-enrolled person is sent to the right page from any screen.
function follow(error: unknown) {
  const to = redirectFor(error);
  if (to && window.location.pathname !== to) window.location.href = to;
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
