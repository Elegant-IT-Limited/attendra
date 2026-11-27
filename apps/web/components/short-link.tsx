// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { Me } from '@attendra/api/contracts';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, Skeleton } from '@/components/ui/feedback';
import { lastClinic } from '@/lib/last-clinic';
import { rememberNext } from '@/lib/next';
import { shortLinkStep } from '@/lib/short-links';

/**
 * A short address on its way (QA-1109-2), by shortLinkStep: a plain request to /me, so someone who was never signed in
 * is not told their session ended. A password to change first keeps the page for after it.
 */
export function ShortLink({ short }: { short: string }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let gone = false;
    setFailed(false);
    void fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store' }).then(async (res) => {
      if (gone) return;
      const me = res.ok ? await res.json() as Me : null;
      const step = shortLinkStep(short, res.status, me?.clinics ?? [], lastClinic());
      if ('failed' in step) return setFailed(true);
      if (step.next) rememberNext(step.next);
      window.location.replace(step.go);
    }).catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [short, attempt]);
  if (failed) {
    return <Empty title="Attendra did not load" action={<Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>The server did not answer. Try again in a moment.</Empty>;
  }
  return <div className="mx-auto mt-24 max-w-sm space-y-3" aria-busy><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-64" /></div>;
}
